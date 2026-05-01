import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import IOSurface
import ObjectiveC

private func createDirectFramebufferCaptureError(_ message: String, code: Int = 1) -> NSError {
  NSError(
    domain: "DirectSimulatorFramebufferCapture",
    code: code,
    userInfo: [NSLocalizedDescriptionKey: message]
  )
}

private func logDirectFramebufferDebug(_ message: String) {
  guard ProcessInfo.processInfo.environment["IOS_SIMULATOR_FRAMEBUFFER_DEBUG"] == "1",
        let data = "[framebuffer-debug] \(message)\n".data(using: .utf8) else {
    return
  }

  FileHandle.standardError.write(data)
}

private func getIosSimulatorFramebufferIdleIntervalMs() -> UInt64 {
  let raw = UInt64(ProcessInfo.processInfo.environment["IOS_SIMULATOR_FRAMEBUFFER_IDLE_MS"] ?? "100")
  guard let raw, raw >= 33, raw <= 1_000 else {
    return 100
  }

  return raw
}

final class DirectSimulatorFramebufferCapture {
  typealias FrameHandler = (CVPixelBuffer, UInt64) -> Void
  private static let idleIntervalMs: UInt64 = getIosSimulatorFramebufferIdleIntervalMs()

  private var callbackUUIDs: [ObjectIdentifier: NSUUID] = [:]
  private let captureQueue = DispatchQueue(label: "codesymphony.simulator-bridge.framebuffer-capture", qos: .userInteractive)
  private var descriptors: [NSObject] = []
  private var frameCount: UInt64 = 0
  private var lastCaptureUptimeMs: UInt64 = 0
  private let stateQueue = DispatchQueue(label: "codesymphony.simulator-bridge.framebuffer-state")
  private var ioClient: NSObject?
  private var lastSeeds: [ObjectIdentifier: UInt32] = [:]
  private var onFrame: FrameHandler?
  private var startupLastError: Error?
  private var maintenanceTimer: DispatchSourceTimer?

  func start(deviceUDID: String, onFrame: @escaping FrameHandler) async throws {
    self.onFrame = onFrame

    _ = dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)
    let simulatorKitPath = Self.getDeveloperDir()
      .appending("/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit")
    _ = dlopen(simulatorKitPath, RTLD_NOW)

    guard let device = Self.findSimDevice(udid: deviceUDID) else {
      throw createDirectFramebufferCaptureError("Device \(deviceUDID) not found.")
    }

    let state = device.value(forKey: "stateString") as? String ?? "unknown"
    guard state == "Booted" else {
      throw createDirectFramebufferCaptureError("Device \(deviceUDID) is not booted (state: \(state)).")
    }

    guard let io = device.perform(NSSelectorFromString("io"))?.takeUnretainedValue() as? NSObject else {
      throw createDirectFramebufferCaptureError("Failed to access the simulator IO client.")
    }

    ioClient = io

    do {
      storeStartupError(nil)
      startMaintenanceTimer()
      do {
        try wireUpFramebuffer()
      } catch {
        storeStartupError(error)
      }
      try await waitForFirstFrame()
    } catch {
      stop()
      throw error
    }
  }

  func stop() {
    maintenanceTimer?.cancel()
    maintenanceTimer = nil

    let unregisterSelector = NSSelectorFromString("unregisterScreenCallbacksWithUUID:")
    for descriptor in descriptors {
      if let uuid = callbackUUIDs[ObjectIdentifier(descriptor)],
         descriptor.responds(to: unregisterSelector) {
        descriptor.perform(unregisterSelector, with: uuid)
      }
    }

    callbackUUIDs.removeAll()
    descriptors.removeAll()
    lastSeeds.removeAll()
    ioClient = nil
    onFrame = nil

    stateQueue.sync {
      frameCount = 0
      lastCaptureUptimeMs = 0
      startupLastError = nil
    }
  }

  private func waitForFirstFrame() async throws {
    let timeoutAt = DispatchTime.now().uptimeNanoseconds + 1_500_000_000

    while true {
      if frameCountValue() > 0 {
        return
      }

      if DispatchTime.now().uptimeNanoseconds >= timeoutAt {
        throw startupErrorValue()
          ?? createDirectFramebufferCaptureError("Timed out waiting for the simulator framebuffer to produce the first frame.")
      }

      try await Task.sleep(nanoseconds: 50_000_000)
    }
  }

  private func startMaintenanceTimer() {
    let timer = DispatchSource.makeTimerSource(queue: captureQueue)
    timer.schedule(
      deadline: .now() + .milliseconds(Int(Self.idleIntervalMs)),
      repeating: .milliseconds(Int(Self.idleIntervalMs))
    )
    timer.setEventHandler { [weak self] in
      guard let self else {
        return
      }

      if self.frameCountValue() == 0 {
        do {
          try self.wireUpFramebuffer()
        } catch {
          self.storeStartupError(error)
        }
        return
      }

      let nowUptimeMs = Self.currentUptimeMs()
      if nowUptimeMs &- self.lastCaptureUptimeMsValue() >= Self.idleIntervalMs {
        self.captureFrame(forceEmit: true)
      }
    }
    timer.resume()
    maintenanceTimer = timer
  }

  private func wireUpFramebuffer() throws {
    guard let ioClient else {
      throw createDirectFramebufferCaptureError("No simulator IO client is available.")
    }

    ioClient.perform(NSSelectorFromString("updateIOPorts"))

    let nextDescriptors = try findFramebufferDescriptors(ioClient: ioClient)

    let unregisterSelector = NSSelectorFromString("unregisterScreenCallbacksWithUUID:")
    for descriptor in descriptors {
      if let uuid = callbackUUIDs[ObjectIdentifier(descriptor)],
         descriptor.responds(to: unregisterSelector) {
        descriptor.perform(unregisterSelector, with: uuid)
      }
    }

    callbackUUIDs.removeAll()
    lastSeeds.removeAll()
    descriptors = nextDescriptors

    for descriptor in nextDescriptors {
      try registerFrameCallbacks(descriptor: descriptor)
    }

    captureFrame(forceEmit: true)
  }

  private func findFramebufferDescriptors(ioClient: NSObject) throws -> [NSObject] {
    guard let deviceIOPorts = ioClient.value(forKey: "deviceIOPorts") as? [NSObject] else {
      throw createDirectFramebufferCaptureError("Failed to enumerate simulator IO ports.")
    }

    let descriptorSelector = NSSelectorFromString("descriptor")
    let surfaceSelector = NSSelectorFromString("framebufferSurface")

    logDirectFramebufferDebug("deviceIOPorts.count=\(deviceIOPorts.count)")
    for (index, port) in deviceIOPorts.enumerated() {
      let descriptorResponds = port.responds(to: descriptorSelector)
      let descriptor = descriptorResponds
        ? port.perform(descriptorSelector)?.takeUnretainedValue() as? NSObject
        : nil
      logDirectFramebufferDebug(
        "port[\(index)] descResponds=\(descriptorResponds) hasDescriptor=\(descriptor != nil) hasSurface=\(descriptor?.responds(to: surfaceSelector) ?? false)"
      )
    }

    let descriptors = deviceIOPorts.compactMap { port -> NSObject? in
      guard port.responds(to: descriptorSelector),
            let descriptor = port.perform(descriptorSelector)?.takeUnretainedValue() as? NSObject,
            descriptor.responds(to: surfaceSelector) else {
        return nil
      }

      return descriptor
    }

    logDirectFramebufferDebug("framebufferDescriptorCount=\(descriptors.count)")

    guard descriptors.isEmpty == false else {
      throw createDirectFramebufferCaptureError("No simulator framebuffer descriptors were found.")
    }

    return descriptors
  }

  private func pickBestDescriptor() -> NSObject? {
    let surfaceSelector = NSSelectorFromString("framebufferSurface")
    var bestDescriptor: NSObject?
    var bestArea = 0

    for descriptor in descriptors {
      guard let surfaceObject = descriptor.perform(surfaceSelector)?.takeUnretainedValue() else {
        continue
      }

      let surface = unsafeBitCast(surfaceObject, to: IOSurface.self)
      let area = IOSurfaceGetWidth(surface) * IOSurfaceGetHeight(surface)
      if area > bestArea {
        bestArea = area
        bestDescriptor = descriptor
      }
    }

    return bestDescriptor
  }

  private func registerFrameCallbacks(descriptor: NSObject) throws {
    let registerSelector = NSSelectorFromString(
      "registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:"
    )
    guard descriptor.responds(to: registerSelector) else {
      throw createDirectFramebufferCaptureError("The framebuffer descriptor does not support screen callbacks.")
    }

    guard let messageSendPointer = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "objc_msgSend") else {
      throw createDirectFramebufferCaptureError("objc_msgSend is unavailable for framebuffer registration.")
    }

    typealias MessageSend = @convention(c) (
      AnyObject,
      Selector,
      AnyObject,
      AnyObject,
      AnyObject,
      AnyObject,
      AnyObject
    ) -> Void

    let messageSend = unsafeBitCast(messageSendPointer, to: MessageSend.self)
    let uuid = NSUUID()
    callbackUUIDs[ObjectIdentifier(descriptor)] = uuid

    let frameCallback: @convention(block) () -> Void = { [weak self] in
      self?.captureQueue.async {
        self?.captureFrame(forceEmit: false)
      }
    }
    let surfacesChangedCallback: @convention(block) () -> Void = { [weak self] in
      self?.captureQueue.async {
        self?.captureFrame(forceEmit: true)
      }
    }
    let propertiesChangedCallback: @convention(block) () -> Void = {}

    messageSend(
      descriptor,
      registerSelector,
      uuid,
      captureQueue as AnyObject,
      frameCallback as AnyObject,
      surfacesChangedCallback as AnyObject,
      propertiesChangedCallback as AnyObject
    )
  }

  private func captureFrame(forceEmit: Bool) {
    guard let descriptor = pickBestDescriptor() else {
      return
    }

    let surfaceSelector = NSSelectorFromString("framebufferSurface")
    guard let surfaceObject = descriptor.perform(surfaceSelector)?.takeUnretainedValue() else {
      return
    }

    let surface = unsafeBitCast(surfaceObject, to: IOSurface.self)
    let key = ObjectIdentifier(descriptor)
    let seed = IOSurfaceGetSeed(surface)
    let hasCapturedFrame = frameCountValue() > 0
    let nowUptimeMs = Self.currentUptimeMs()
    let idleRefreshDue = hasCapturedFrame && nowUptimeMs &- lastCaptureUptimeMsValue() >= Self.idleIntervalMs

    if hasCapturedFrame, lastSeeds[key] == seed, !forceEmit, !idleRefreshDue {
      return
    }

    lastSeeds[key] = seed

    let width = IOSurfaceGetWidth(surface)
    let height = IOSurfaceGetHeight(surface)
    guard width > 0, height > 0 else {
      return
    }

    var pixelBuffer: Unmanaged<CVPixelBuffer>?
    let status = CVPixelBufferCreateWithIOSurface(
      kCFAllocatorDefault,
      surface,
      [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA] as CFDictionary,
      &pixelBuffer
    )

    guard status == kCVReturnSuccess, let pixelBuffer = pixelBuffer?.takeRetainedValue() else {
      return
    }

    setLastCaptureUptimeMs(nowUptimeMs)
    incrementFrameCount()
    onFrame?(pixelBuffer, Self.currentUnixTimestampMs())
  }

  private func frameCountValue() -> UInt64 {
    stateQueue.sync {
      frameCount
    }
  }

  private func startupErrorValue() -> Error? {
    stateQueue.sync {
      startupLastError
    }
  }

  private func lastCaptureUptimeMsValue() -> UInt64 {
    stateQueue.sync {
      lastCaptureUptimeMs
    }
  }

  private func setLastCaptureUptimeMs(_ value: UInt64) {
    stateQueue.sync {
      lastCaptureUptimeMs = value
    }
  }

  private func storeStartupError(_ error: Error?) {
    stateQueue.sync {
      startupLastError = error
    }
  }

  private func incrementFrameCount() {
    stateQueue.sync {
      frameCount += 1
    }
  }

  private static func currentUnixTimestampMs() -> UInt64 {
    UInt64(Date().timeIntervalSince1970 * 1000)
  }

  private static func currentUptimeMs() -> UInt64 {
    DispatchTime.now().uptimeNanoseconds / 1_000_000
  }

  static func findSimDevice(udid: String) -> NSObject? {
    guard let contextClass = NSClassFromString("SimServiceContext") as? NSObject.Type else {
      return nil
    }

    let sharedSelector = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
    guard let context = contextClass.perform(sharedSelector, with: getDeveloperDir(), with: nil)?
      .takeUnretainedValue() as? NSObject else {
      return nil
    }

    let defaultDeviceSetSelector = NSSelectorFromString("defaultDeviceSetWithError:")
    guard let deviceSet = context.perform(defaultDeviceSetSelector, with: nil)?
      .takeUnretainedValue() as? NSObject else {
      return nil
    }

    guard let devices = deviceSet.value(forKey: "devices") as? [NSObject] else {
      return nil
    }

    return devices.first(where: {
      ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid
    })
  }

  static func getDeveloperDir() -> String {
    let pipe = Pipe()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
    process.arguments = ["-p"]
    process.standardOutput = pipe
    try? process.run()
    process.waitUntilExit()

    let developerDir = String(
      data: pipe.fileHandleForReading.readDataToEndOfFile(),
      encoding: .utf8
    )?.trimmingCharacters(in: .whitespacesAndNewlines)

    return developerDir?.isEmpty == false
      ? developerDir!
      : "/Applications/Xcode.app/Contents/Developer"
  }
}
