import AppKit
import ApplicationServices
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import VideoToolbox
#if canImport(FBControlCore) && canImport(FBSimulatorControl)
import FBControlCore
import FBSimulatorControl
#endif

private enum BridgeError: LocalizedError {
  case invalidArguments(String)
  case simulatorNotBooted(String)
  case simulatorWindowUnavailable(String)
  case inaccessibleDisplayArea(String)
  case failedToCreateEncoder
  case simulatorProcessUnavailable(String)
  case failedToCreateEvent(String)
  case simctlCommandFailed(String)

  var errorDescription: String? {
    switch self {
    case .invalidArguments(let message):
      return message
    case .simulatorNotBooted(let udid):
      return "Booted iOS simulator not found for \(udid)."
    case .simulatorWindowUnavailable(let udid):
      return "Unable to find a visible Simulator window for \(udid)."
    case .inaccessibleDisplayArea(let udid):
      return "Unable to resolve the iOS display bounds inside the Simulator window for \(udid)."
    case .failedToCreateEncoder:
      return "Unable to initialize the H.264 encoder."
    case .simulatorProcessUnavailable(let udid):
      return "Unable to resolve the Simulator process for \(udid)."
    case .failedToCreateEvent(let message):
      return message
    case .simctlCommandFailed(let message):
      return message
    }
  }
}

private enum BridgePacketType: UInt8 {
  case metadata = 0
  case config = 1
  case keyFrame = 2
  case deltaFrame = 3
}

private struct StreamCommand {
  let fps: Int
  let udid: String
}

private struct StatusCommand {
  let udid: String
}

private struct DragPathPoint {
  let delayMs: Double
  let x: Double
  let y: Double
}

private let SIMULATOR_HARDWARE_KEYBOARD_TYPE_DEFAULT: UInt8 = 0

private enum IosSimulatorCaptureModePreference {
  case framebuffer
  case window
}

private enum IosSimulatorStreamCodec {
  case h264
  case jpeg
}

private enum IosSimulatorStreamCodecPreference {
  case automatic
  case h264
  case jpeg
}

private func getIosSimulatorCaptureModePreference() -> IosSimulatorCaptureModePreference {
  let raw = ProcessInfo.processInfo.environment["IOS_SIMULATOR_CAPTURE_MODE"]?
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()

  switch raw {
  case "window", "screen", "screencapturekit":
    return .window
  default:
    return .framebuffer
  }
}

private func getIosSimulatorStreamCodecPreference() -> IosSimulatorStreamCodecPreference {
  let raw = ProcessInfo.processInfo.environment["IOS_SIMULATOR_STREAM_CODEC"]?
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()

  switch raw {
  case "h264", "avc", "avc1":
    return .h264
  case "jpeg", "jpg":
    return .jpeg
  default:
    return .automatic
  }
}

private func preferredIosSimulatorStreamCodec(
  for captureMode: IosSimulatorCaptureModePreference
) -> IosSimulatorStreamCodec {
  switch getIosSimulatorStreamCodecPreference() {
  case .h264:
    return .h264
  case .jpeg:
    return .jpeg
  case .automatic:
    return .jpeg
  }
}

private func getIosSimulatorFramebufferStreamScale() -> CGFloat {
  let raw = Double(ProcessInfo.processInfo.environment["IOS_SIMULATOR_FRAMEBUFFER_SCALE"] ?? "1") ?? 1
  guard raw.isFinite, raw >= 0.5, raw <= 3 else {
    return 1
  }

  return CGFloat(raw)
}

private func preferredFramebufferTargetPixelSize(
  screenSize: DeviceProfile.ScreenSize?
) -> (height: Int, width: Int)? {
  guard
    let screenSize,
    screenSize.width > 0,
    screenSize.height > 0
  else {
    return nil
  }

  let scale = getIosSimulatorFramebufferStreamScale()
  return (
    height: max(Int((screenSize.height * scale).rounded()), 1),
    width: max(Int((screenSize.width * scale).rounded()), 1)
  )
}

private enum ControlAction {
  case tap(x: Double, y: Double)
  case touch(x: Double, y: Double, phase: String, edge: String?)
  case drag(phase: String, points: [DragPathPoint])
  case swipe(startX: Double, startY: Double, endX: Double, endY: Double, duration: Double, delta: Double?)
  case text(String)
  case key(String, duration: Double?)
  case button(String)
  case systemGesture(String)
}

private struct ControlCommand {
  let udid: String
  let action: ControlAction
}

private enum BridgeCommand {
  case stream(StreamCommand)
  case status(StatusCommand)
  case control(ControlCommand)

  static func parse() throws -> BridgeCommand {
    let args = Array(CommandLine.arguments.dropFirst())
    guard let subcommand = args.first else {
      throw BridgeError.invalidArguments(usageText)
    }

    switch subcommand {
    case "stream":
      return .stream(try parseStreamCommand(arguments: Array(args.dropFirst())))
    case "status":
      return .status(try parseStatusCommand(arguments: Array(args.dropFirst())))
    case "control":
      return .control(try parseControlCommand(arguments: Array(args.dropFirst())))
    default:
      throw BridgeError.invalidArguments(usageText)
    }
  }

  private static let usageText =
    """
    Usage:
      SimulatorBridge stream --udid <SIMULATOR_UDID> [--fps 60]
      SimulatorBridge status --udid <SIMULATOR_UDID>
      SimulatorBridge control --udid <SIMULATOR_UDID> --action <tap|touch|drag|swipe|text|key|button|system> [options]
    """

  private static func parseStreamCommand(arguments args: [String]) throws -> StreamCommand {
    var udid: String?
    var fps = 60
    var index = 0

    while index < args.count {
      let argument = args[index]
      switch argument {
      case "--udid":
        index += 1
        guard index < args.count else {
          throw BridgeError.invalidArguments("Missing value for --udid")
        }
        udid = args[index]
      case "--fps":
        index += 1
        guard index < args.count, let parsed = Int(args[index]), parsed >= 1, parsed <= 60 else {
          throw BridgeError.invalidArguments("Expected an integer between 1 and 60 for --fps")
        }
        fps = parsed
      default:
        throw BridgeError.invalidArguments("Unknown argument: \(argument)")
      }

      index += 1
    }

    guard let udid, udid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
      throw BridgeError.invalidArguments("The --udid argument is required.")
    }

    return StreamCommand(fps: fps, udid: udid)
  }

  private static func parseStatusCommand(arguments args: [String]) throws -> StatusCommand {
    guard args.count == 2, args[0] == "--udid" else {
      throw BridgeError.invalidArguments("Usage: SimulatorBridge status --udid <SIMULATOR_UDID>")
    }

    let udid = args[1].trimmingCharacters(in: .whitespacesAndNewlines)
    guard udid.isEmpty == false else {
      throw BridgeError.invalidArguments("The --udid argument is required.")
    }

    return StatusCommand(udid: udid)
  }

  private static func parseControlCommand(arguments args: [String]) throws -> ControlCommand {
    var udid: String?
    var actionName: String?
    var values: [String: String] = [:]
    var index = 0

    while index < args.count {
      let argument = args[index]
      guard argument.hasPrefix("--") else {
        throw BridgeError.invalidArguments("Unexpected argument: \(argument)")
      }

      index += 1
      guard index < args.count else {
        throw BridgeError.invalidArguments("Missing value for \(argument)")
      }

      let value = args[index]
      switch argument {
      case "--udid":
        udid = value
      case "--action":
        actionName = value
      default:
        values[String(argument.dropFirst(2))] = value
      }
      index += 1
    }

    guard let udid, udid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
      throw BridgeError.invalidArguments("The --udid argument is required.")
    }

    guard let actionName else {
      throw BridgeError.invalidArguments("The --action argument is required.")
    }

    let action: ControlAction
    switch actionName {
    case "tap":
      guard
        let x = values["x"].flatMap(Double.init),
        let y = values["y"].flatMap(Double.init)
      else {
        throw BridgeError.invalidArguments("tap requires --x <value> and --y <value>.")
      }
      action = .tap(x: x, y: y)
    case "touch":
      guard
        let x = values["x"].flatMap(Double.init),
        let y = values["y"].flatMap(Double.init)
      else {
        throw BridgeError.invalidArguments("touch requires --x <value> and --y <value>.")
      }

      let phase = values["phase"]?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
      guard phase == "down" || phase == "move" || phase == "up" else {
        throw BridgeError.invalidArguments("touch requires --phase <down|move|up>.")
      }
      action = .touch(x: x, y: y, phase: phase, edge: values["edge"])
    case "drag":
      let phase = values["phase"]?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
      guard phase == "start" || phase == "move" || phase == "end" else {
        throw BridgeError.invalidArguments("drag requires --phase <start|move|end>.")
      }
      guard let pointsJson = values["points-json"] else {
        throw BridgeError.invalidArguments("drag requires --points-json <json-array>.")
      }
      action = .drag(phase: phase, points: try parseDragPoints(pointsJson))
    case "swipe":
      guard
        let startX = values["start-x"].flatMap(Double.init),
        let startY = values["start-y"].flatMap(Double.init),
        let endX = values["end-x"].flatMap(Double.init),
        let endY = values["end-y"].flatMap(Double.init)
      else {
        throw BridgeError.invalidArguments(
          "swipe requires --start-x, --start-y, --end-x, and --end-y values."
        )
      }

      let duration = values["duration"].flatMap(Double.init) ?? 0.2
      let delta = values["delta"].flatMap(Double.init)
      action = .swipe(
        startX: startX,
        startY: startY,
        endX: endX,
        endY: endY,
        duration: duration,
        delta: delta
      )
    case "text":
      guard let text = values["text"] else {
        throw BridgeError.invalidArguments("text requires --text <value>.")
      }
      action = .text(text)
    case "key":
      guard let key = values["key"] else {
        throw BridgeError.invalidArguments("key requires --key <value>.")
      }
      action = .key(key, duration: values["duration"].flatMap(Double.init))
    case "button":
      guard let button = values["button"] else {
        throw BridgeError.invalidArguments("button requires --button <home|lock>.")
      }
      action = .button(button)
    case "system":
      guard let name = values["name"] else {
        throw BridgeError.invalidArguments("system requires --name <gesture>.")
      }
      action = .systemGesture(name)
    default:
      throw BridgeError.invalidArguments("Unsupported control action: \(actionName)")
    }

    return ControlCommand(udid: udid, action: action)
  }

  private static func parseDragPoints(_ json: String) throws -> [DragPathPoint] {
    guard let data = json.data(using: .utf8) else {
      throw BridgeError.invalidArguments("drag points json is not valid UTF-8.")
    }

    guard let rawPoints = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
      throw BridgeError.invalidArguments("drag points json must be an array of point objects.")
    }

    return try rawPoints.map { rawPoint in
      let x = try readNumericValue(rawPoint, key: "x", context: "drag point")
      let y = try readNumericValue(rawPoint, key: "y", context: "drag point")
      let delayMs = readOptionalNumericValue(rawPoint, key: "delay_ms") ?? 0
      return DragPathPoint(delayMs: delayMs, x: x, y: y)
    }
  }

  private static func readNumericValue(_ payload: [String: Any], key: String, context: String) throws -> Double {
    if let value = payload[key] as? NSNumber {
      return value.doubleValue
    }
    if let value = payload[key] as? String, let parsed = Double(value) {
      return parsed
    }
    throw BridgeError.invalidArguments("Missing numeric \(context) field: \(key)")
  }

  private static func readOptionalNumericValue(_ payload: [String: Any], key: String) -> Double? {
    if let value = payload[key] as? NSNumber {
      return value.doubleValue
    }
    if let value = payload[key] as? String {
      return Double(value)
    }
    return nil
  }
}

private struct BootedSimulator: Decodable {
  let deviceTypeIdentifier: String?
  let name: String
  let osLabel: String
  let udid: String
}

private enum DeviceProfile {
  struct ScreenSize {
    let height: CGFloat
    let width: CGFloat
  }

  private static let profilesDirectory = "/Library/Developer/CoreSimulator/Profiles/DeviceTypes"
  private static var cache: [String: ScreenSize] = [:]

  static func screenSize(for deviceTypeIdentifier: String?) -> ScreenSize? {
    guard let deviceTypeIdentifier, deviceTypeIdentifier.isEmpty == false else {
      return nil
    }

    if let cached = cache[deviceTypeIdentifier] {
      return cached;
    }

    loadAllProfiles()
    return cache[deviceTypeIdentifier]
  }

  private static func loadAllProfiles() {
    guard cache.isEmpty else {
      return
    }

    let fileManager = FileManager.default
    let url = URL(fileURLWithPath: profilesDirectory)
    guard let bundles = try? fileManager.contentsOfDirectory(at: url, includingPropertiesForKeys: nil) else {
      return
    }

    for bundle in bundles where bundle.pathExtension == "simdevicetype" {
      let infoPlist = bundle.appendingPathComponent("Contents/Info.plist")
      let profilePlist = bundle.appendingPathComponent("Contents/Resources/profile.plist")

      guard
        let infoData = try? Data(contentsOf: infoPlist),
        let infoDict = try? PropertyListSerialization.propertyList(from: infoData, format: nil) as? [String: Any],
        let identifier = infoDict["CFBundleIdentifier"] as? String,
        let profileData = try? Data(contentsOf: profilePlist),
        let profileDict = try? PropertyListSerialization.propertyList(from: profileData, format: nil) as? [String: Any],
        let pixelWidth = profileDict["mainScreenWidth"] as? Int,
        let pixelHeight = profileDict["mainScreenHeight"] as? Int,
        let scale = profileDict["mainScreenScale"] as? Int,
        scale > 0
      else {
        continue
      }

      cache[identifier] = ScreenSize(
        height: CGFloat(pixelHeight) / CGFloat(scale),
        width: CGFloat(pixelWidth) / CGFloat(scale)
      )
    }
  }
}

private struct SimulatorWindowMatch {
  let captureRect: CGRect
  let captureDisplay: SCDisplay
  let device: BootedSimulator
  let absoluteDisplayRect: CGRect
  let pixelHeight: Int
  let pixelWidth: Int
  let processID: pid_t
  let window: SCWindow
}

private struct SimulatorInteractionMatch {
  let device: BootedSimulator
  let absoluteDisplayRect: CGRect
  let pixelHeight: Int
  let pixelWidth: Int
  let processID: pid_t
}

private struct SimulatorSystemWindow {
  let frame: CGRect
  let processID: pid_t
  let title: String?
}

private struct SimulatorStatusPayload: Encodable {
  struct SessionInfo: Encodable {
    let device_height: Int
    let device_width: Int
    let keyboard_sync_available: Bool
    let pixel_height: Int
    let pixel_width: Int
    let software_keyboard_visible: Bool
  }

  let session_info: SessionInfo
}

private struct KeyboardSyncState: Equatable {
  let available: Bool
  let visible: Bool
}

private struct StreamMetadata: Encodable, Equatable {
  let codec: String
  let deviceName: String
  let keyboardSyncAvailable: Bool
  let pointHeight: Int
  let pointWidth: Int
  let pixelHeight: Int
  let pixelWidth: Int
  let softwareKeyboardVisible: Bool
  let udid: String
}

private final class PacketWriter {
  private let lock = NSLock()
  private let fileHandle = FileHandle.standardOutput

  func sendJSON<T: Encodable>(_ value: T) throws {
    let payload = try JSONEncoder().encode(value)
    try send(type: .metadata, payload: payload)
  }

  func send(type: BridgePacketType, payload: Data) throws {
    var length = UInt32(payload.count + 1).bigEndian
    var buffer = Data(bytes: &length, count: MemoryLayout<UInt32>.size)
    buffer.append(type.rawValue)
    buffer.append(payload)

    lock.lock()
    defer { lock.unlock() }

    try fileHandle.write(contentsOf: buffer)
  }

  func sendFrame(type: BridgePacketType, payload: Data, capturedAtMs: UInt64) throws {
    var capturedAtMsBigEndian = capturedAtMs.bigEndian
    var framedPayload = Data(bytes: &capturedAtMsBigEndian, count: MemoryLayout<UInt64>.size)
    framedPayload.append(payload)
    try send(type: type, payload: framedPayload)
  }
}

private enum StderrLogger {
  static func log(_ message: String) {
    guard let data = "\(message)\n".data(using: .utf8) else {
      return
    }

    FileHandle.standardError.write(data)
  }
}

private final class EncodedFrameContext {
  let capturedAtMs: UInt64

  init(capturedAtMs: UInt64) {
    self.capturedAtMs = capturedAtMs
  }
}

private struct PendingVideoFrame {
  let capturedAtMs: UInt64
  let changeRatio: Double?
  let pixelBuffer: CVPixelBuffer
}

private protocol StreamVideoEncoder: AnyObject {
  func encode(sampleBuffer: CMSampleBuffer, capturedAtMs: UInt64) throws
  func encode(pixelBuffer: CVPixelBuffer, capturedAtMs: UInt64, changeRatio: Double?) throws
  func finish()
  func updateTargetPixelSize(height: Int?, width: Int?)
}

private final class JpegEncoder: StreamVideoEncoder {
  private let metadataObserver: (StreamMetadata) -> Void
  private let metadataStateProvider: () -> KeyboardSyncState
  private let writer: PacketWriter
  private let deviceName: String
  private let pointHeight: Int
  private let pointWidth: Int
  private let udid: String
  private let ciContext = CIContext()
  private let colorSpace = CGColorSpaceCreateDeviceRGB()

  private var lastMetadataSignature = ""
  private var targetPixelHeight: Int?
  private var targetPixelWidth: Int?

  init(
    deviceName: String,
    pointHeight: Int,
    pointWidth: Int,
    udid: String,
    writer: PacketWriter,
    metadataStateProvider: @escaping () -> KeyboardSyncState,
    metadataObserver: @escaping (StreamMetadata) -> Void
  ) {
    self.deviceName = deviceName
    self.metadataObserver = metadataObserver
    self.metadataStateProvider = metadataStateProvider
    self.pointHeight = pointHeight
    self.pointWidth = pointWidth
    self.udid = udid
    self.writer = writer
  }

  func updateTargetPixelSize(height: Int?, width: Int?) {
    targetPixelHeight = height
    targetPixelWidth = width
  }

  func encode(sampleBuffer: CMSampleBuffer, capturedAtMs: UInt64) throws {
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
      return
    }

    try encode(pixelBuffer: pixelBuffer, capturedAtMs: capturedAtMs, changeRatio: nil)
  }

  func encode(pixelBuffer: CVPixelBuffer, capturedAtMs: UInt64, changeRatio: Double?) throws {
    let sourceWidth = max(CVPixelBufferGetWidth(pixelBuffer), 1)
    let sourceHeight = max(CVPixelBufferGetHeight(pixelBuffer), 1)
    let sourceImage = CIImage(cvPixelBuffer: pixelBuffer)
    let encodedImage = scaledImageIfNeeded(image: sourceImage, sourceHeight: sourceHeight, sourceWidth: sourceWidth)
    let width = max(Int(encodedImage.extent.width.rounded()), 1)
    let height = max(Int(encodedImage.extent.height.rounded()), 1)
    let metadataSignature = "jpeg:\(width)x\(height)"

    if metadataSignature != lastMetadataSignature {
      lastMetadataSignature = metadataSignature
      let keyboardSyncState = metadataStateProvider()
      let metadata = StreamMetadata(
        codec: "jpeg",
        deviceName: deviceName,
        keyboardSyncAvailable: keyboardSyncState.available,
        pointHeight: pointHeight,
        pointWidth: pointWidth,
        pixelHeight: height,
        pixelWidth: width,
        softwareKeyboardVisible: keyboardSyncState.visible,
        udid: udid
      )
      metadataObserver(metadata)
      try writer.sendJSON(metadata)
    }

    let compressionQuality = jpegCompressionQuality(
      pixelWidth: width,
      pixelHeight: height,
      changeRatio: changeRatio
    )
    guard let jpegData = ciContext.jpegRepresentation(
      of: encodedImage,
      colorSpace: colorSpace,
      options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: compressionQuality]
    ) else {
      throw BridgeError.failedToCreateEncoder
    }

    try writer.sendFrame(type: .keyFrame, payload: jpegData as Data, capturedAtMs: capturedAtMs)
  }

  func finish() {}

  private func scaledImageIfNeeded(image: CIImage, sourceHeight: Int, sourceWidth: Int) -> CIImage {
    guard
      let requestedWidth = targetPixelWidth,
      let requestedHeight = targetPixelHeight,
      requestedWidth > 0,
      requestedHeight > 0,
      sourceWidth > 0,
      sourceHeight > 0
    else {
      return image
    }

    let widthScale = CGFloat(requestedWidth) / CGFloat(sourceWidth)
    let heightScale = CGFloat(requestedHeight) / CGFloat(sourceHeight)
    let scale = min(widthScale, heightScale, 1)
    guard scale < 0.999 else {
      return image
    }

    return image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
  }

  private func jpegCompressionQuality(pixelWidth: Int, pixelHeight: Int, changeRatio: Double?) -> Double {
    let pixelCount = max(pixelWidth, 1) * max(pixelHeight, 1)
    let baseQuality: Double
    if pixelCount <= 400_000 {
      baseQuality = 0.84
    } else if pixelCount <= 900_000 {
      baseQuality = 0.8
    } else {
      baseQuality = 0.76
    }

    guard let changeRatio else {
      return baseQuality
    }

    let normalizedChangeRatio = min(max(changeRatio, 0), 1)
    if normalizedChangeRatio <= 0.02 {
      return min(baseQuality + 0.05, 0.9)
    }
    if normalizedChangeRatio <= 0.08 {
      return min(baseQuality + 0.03, 0.88)
    }
    if normalizedChangeRatio <= 0.2 {
      return min(baseQuality + 0.02, 0.86)
    }
    if normalizedChangeRatio >= 0.75 {
      return max(baseQuality - 0.08, 0.68)
    }
    if normalizedChangeRatio >= 0.4 {
      return max(baseQuality - 0.05, 0.7)
    }
    return baseQuality
  }
}

private final class SignalTrap {
  private var sources: [DispatchSourceSignal] = []

  func install(_ handler: @escaping () -> Void) {
    for signalValue in [SIGINT, SIGTERM] {
      signal(signalValue, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: signalValue, queue: .main)
      source.setEventHandler(handler: handler)
      source.resume()
      sources.append(source)
    }
  }
}

@MainActor
private final class BridgeProcessState {
  static let shared = BridgeProcessState()

  var runner: StreamCommandRunner?
  var signalTrap: SignalTrap?
}

private enum SimulatorDiscovery {
  private struct SimctlPayload: Decodable {
    let devices: [String: [SimctlDevice]]
  }

  private struct SimctlDevice: Decodable {
    let deviceTypeIdentifier: String?
    let isAvailable: Bool?
    let name: String
    let state: String
    let udid: String
  }

  static func bootedSimulator(udid: String) throws -> BootedSimulator {
    let devices = try bootedSimulators()
    guard let device = devices.first(where: { $0.udid == udid }) else {
      throw BridgeError.simulatorNotBooted(udid)
    }

    return device
  }

  static func resolve(udid: String) async throws -> SimulatorWindowMatch {
    let devices = try bootedSimulators()
    let device = try bootedSimulator(udid: udid)
    let screenSize = DeviceProfile.screenSize(for: device.deviceTypeIdentifier)

    let shareableContent = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    let windows = shareableContent
      .windows
      .filter { $0.owningApplication?.bundleIdentifier == "com.apple.iphonesimulator" }
      .filter { $0.frame.width >= 50 && $0.frame.height >= 50 }

    let matchingWindow = findWindow(for: device, among: windows, bootedDevices: devices, title: { $0.title })
    guard let window = matchingWindow else {
      throw BridgeError.simulatorWindowUnavailable(udid)
    }

    guard let processID = window.owningApplication?.processID, processID > 0 else {
      throw BridgeError.simulatorProcessUnavailable(udid)
    }

    let backingScale = await MainActor.run {
      NSScreen.screens.first(where: { $0.frame.intersects(window.frame) })?.backingScaleFactor ?? 1.0
    }

    let captureRect = WindowDisplayResolver.captureRect(for: window, deviceScreenSize: screenSize)
    guard captureRect.width > 0, captureRect.height > 0 else {
      throw BridgeError.inaccessibleDisplayArea(udid)
    }

    let absoluteDisplayRect = CGRect(
      x: window.frame.origin.x + captureRect.origin.x,
      y: window.frame.origin.y + captureRect.origin.y,
      width: captureRect.width,
      height: captureRect.height
    )

    guard let captureDisplay = findCaptureDisplay(for: absoluteDisplayRect, among: shareableContent.displays) else {
      throw BridgeError.inaccessibleDisplayArea(udid)
    }

    return SimulatorWindowMatch(
      captureRect: captureRect,
      captureDisplay: captureDisplay,
      device: device,
      absoluteDisplayRect: absoluteDisplayRect,
      pixelHeight: roundedCapturePixelDimension(captureRect.height * backingScale),
      pixelWidth: roundedCapturePixelDimension(captureRect.width * backingScale),
      processID: pid_t(processID),
      window: window
    )
  }

  static func resolveInteraction(udid: String) async throws -> SimulatorInteractionMatch {
    let devices = try bootedSimulators()
    let device = try bootedSimulator(udid: udid)
    let screenSize = DeviceProfile.screenSize(for: device.deviceTypeIdentifier)

    let matchingWindow = findSystemWindow(for: device, bootedDevices: devices)
    guard let window = matchingWindow else {
      throw BridgeError.simulatorWindowUnavailable(udid)
    }

    let backingScale = await MainActor.run {
      NSScreen.screens.first(where: { $0.frame.intersects(window.frame) })?.backingScaleFactor ?? 1.0
    }

    let captureRect = WindowDisplayResolver.captureRect(
      pid: window.processID,
      windowFrame: window.frame,
      deviceScreenSize: screenSize
    )
    guard captureRect.width > 0, captureRect.height > 0 else {
      throw BridgeError.inaccessibleDisplayArea(udid)
    }

    return SimulatorInteractionMatch(
      device: device,
      absoluteDisplayRect: CGRect(
        x: window.frame.origin.x + captureRect.origin.x,
        y: window.frame.origin.y + captureRect.origin.y,
        width: captureRect.width,
        height: captureRect.height
      ),
      pixelHeight: roundedCapturePixelDimension(captureRect.height * backingScale),
      pixelWidth: roundedCapturePixelDimension(captureRect.width * backingScale),
      processID: window.processID
    )
  }

  private static func bootedSimulators() throws -> [BootedSimulator] {
    let process = Process()
    let output = Pipe()
    let error = Pipe()

    process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
    process.arguments = ["simctl", "list", "devices", "available", "--json"]
    process.standardOutput = output
    process.standardError = error

    try process.run()
    process.waitUntilExit()

    guard process.terminationStatus == 0 else {
      let stderr = String(data: error.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
      throw BridgeError.invalidArguments(stderr?.isEmpty == false ? stderr! : "Failed to query booted simulators with simctl.")
    }

    let data = output.fileHandleForReading.readDataToEndOfFile()
    let payload = try JSONDecoder().decode(SimctlPayload.self, from: data)

    return payload.devices.flatMap { runtime, entries in
      entries.compactMap { device in
        guard device.state == "Booted", device.isAvailable ?? true else {
          return nil
        }

        return BootedSimulator(
          deviceTypeIdentifier: device.deviceTypeIdentifier,
          name: device.name,
          osLabel: osLabel(for: runtime),
          udid: device.udid
        )
      }
    }
  }

  private static func findWindow<T>(
    for device: BootedSimulator,
    among windows: [T],
    bootedDevices: [BootedSimulator],
    title: (T) -> String?
  ) -> T? {
    let disambiguatedTitle = "\(device.name) – \(device.osLabel)"

    if let window = windows.first(where: { title($0) == disambiguatedTitle }) {
      return window
    }

    let sameNameDevices = bootedDevices.filter { $0.name == device.name }
    if sameNameDevices.count == 1, let window = windows.first(where: { title($0) == device.name }) {
      return window
    }

    if let window = windows.first(where: {
      let value = title($0) ?? ""
      return value.contains(device.name) && value.contains(device.osLabel)
    }) {
      return window
    }

    if sameNameDevices.count == 1, let window = windows.first(where: { (title($0) ?? "").contains(device.name) }) {
      return window
    }

    if windows.count == 1 && bootedDevices.count == 1 {
      return windows[0]
    }

    return nil
  }

  private static func osLabel(for runtimeIdentifier: String) -> String {
    let raw = runtimeIdentifier
      .split(separator: ".")
      .last
      .map(String.init) ?? runtimeIdentifier

    if raw.hasPrefix("iOS-") {
      return "iOS " + raw.dropFirst(4).replacingOccurrences(of: "-", with: ".")
    }

    if raw.hasPrefix("iPadOS-") {
      return "iPadOS " + raw.dropFirst(7).replacingOccurrences(of: "-", with: ".")
    }

    return raw.replacingOccurrences(of: "-", with: ".")
  }

  private static func findCaptureDisplay(for targetRect: CGRect, among displays: [SCDisplay]) -> SCDisplay? {
    var bestDisplay: SCDisplay?
    var bestArea: CGFloat = 0

    for display in displays {
      let intersection = display.frame.intersection(targetRect)
      let area = intersection.width * intersection.height
      if area > bestArea {
        bestArea = area
        bestDisplay = display
      }
    }

    if bestArea > 0, let bestDisplay {
      return bestDisplay
    }

    return displays.first(where: { $0.frame.contains(targetRect) })
      ?? displays.first(where: { $0.frame.intersects(targetRect) })
  }

  private static func findSystemWindow(
    for device: BootedSimulator,
    bootedDevices: [BootedSimulator]
  ) -> SimulatorSystemWindow? {
    guard let rawWindowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]] else {
      return nil
    }

    let windows = rawWindowList.compactMap { entry -> SimulatorSystemWindow? in
      guard let ownerName = entry[kCGWindowOwnerName as String] as? String,
            ownerName == "Simulator",
            let processID = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
            let boundsDictionary = entry[kCGWindowBounds as String] as? NSDictionary,
            let frame = CGRect(dictionaryRepresentation: boundsDictionary) else {
        return nil
      }

      let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
      let alpha = (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
      if layer != 0 || alpha <= 0 || frame.width < 50 || frame.height < 50 {
        return nil
      }

      return SimulatorSystemWindow(
        frame: frame,
        processID: pid_t(processID),
        title: entry[kCGWindowName as String] as? String
      )
    }

    return findWindow(for: device, among: windows, bootedDevices: bootedDevices, title: { $0.title })
  }
}

private enum WindowDisplayResolver {
  static func captureRect(for window: SCWindow, deviceScreenSize: DeviceProfile.ScreenSize? = nil) -> CGRect {
    guard
      let processID = window.owningApplication?.processID,
      processID > 0
    else {
      return estimatedCaptureRect(windowFrame: window.frame, deviceScreenSize: deviceScreenSize)
        ?? CGRect(origin: .zero, size: window.frame.size)
    }

    return captureRect(pid: pid_t(processID), windowFrame: window.frame, deviceScreenSize: deviceScreenSize)
  }

  static func captureRect(
    pid: pid_t,
    windowFrame: CGRect,
    deviceScreenSize: DeviceProfile.ScreenSize? = nil
  ) -> CGRect {
    guard let simulatorFrame = findSimDisplayFrame(pid: pid, windowFrame: windowFrame) else {
      return estimatedCaptureRect(windowFrame: windowFrame, deviceScreenSize: deviceScreenSize)
        ?? CGRect(origin: .zero, size: windowFrame.size)
    }

    return CGRect(
      x: simulatorFrame.origin.x - windowFrame.origin.x,
      y: simulatorFrame.origin.y - windowFrame.origin.y,
      width: simulatorFrame.width,
      height: simulatorFrame.height
    )
  }

  private static func estimatedCaptureRect(
    windowFrame: CGRect,
    deviceScreenSize: DeviceProfile.ScreenSize?
  ) -> CGRect? {
    guard
      let deviceScreenSize,
      deviceScreenSize.width > 0,
      deviceScreenSize.height > 0,
      windowFrame.width > 0,
      windowFrame.height > 0
    else {
      return nil
    }

    let aspectRatio = deviceScreenSize.width / deviceScreenSize.height
    let isLandscape = aspectRatio > 1
    let topInset = min(max(windowFrame.height * (isLandscape ? 0.045 : 0.055), 24), 96)
    let bottomInset = min(max(windowFrame.height * (isLandscape ? 0.04 : 0.03), 12), 56)
    let sideInset = min(max(windowFrame.width * (isLandscape ? 0.03 : 0.045), 12), 56)
    let availableRect = CGRect(
      x: sideInset,
      y: topInset,
      width: max(windowFrame.width - (sideInset * 2), 1),
      height: max(windowFrame.height - topInset - bottomInset, 1)
    )
    let fittedRect = aspectFitRect(aspectRatio: aspectRatio, in: availableRect)

    StderrLogger.log(
      "Using estimated simulator display rect for window \(Int(windowFrame.width))x\(Int(windowFrame.height))."
    )

    return CGRect(
      x: max(fittedRect.origin.x.rounded(), 0),
      y: max(fittedRect.origin.y.rounded(), 0),
      width: max(fittedRect.width.rounded(), 1),
      height: max(fittedRect.height.rounded(), 1)
    )
  }

  private static func aspectFitRect(aspectRatio: CGFloat, in boundingRect: CGRect) -> CGRect {
    guard aspectRatio > 0, boundingRect.width > 0, boundingRect.height > 0 else {
      return boundingRect
    }

    let boundingAspect = boundingRect.width / boundingRect.height
    if boundingAspect >= aspectRatio {
      let height = boundingRect.height
      let width = height * aspectRatio
      return CGRect(
        x: boundingRect.minX + ((boundingRect.width - width) / 2),
        y: boundingRect.minY,
        width: width,
        height: height
      )
    }

    let width = boundingRect.width
    let height = width / aspectRatio
    return CGRect(
      x: boundingRect.minX,
      y: boundingRect.minY + ((boundingRect.height - height) / 2),
      width: width,
      height: height
    )
  }

  private static func findSimDisplayFrame(pid: pid_t, windowFrame: CGRect) -> CGRect? {
    let app = AXUIElementCreateApplication(pid)
    if let axWindow = findAXWindow(in: app, matching: windowFrame),
       let frame = findSimDisplayFrame(in: axWindow) {
      return frame
    }
    return findSimDisplayFrame(in: app)
  }

  private static func findSimDisplayFrame(in element: AXUIElement) -> CGRect? {
    var subroleRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subroleRef) == .success,
       let subrole = subroleRef as? String, subrole == "iOSContentGroup" {
      var frameRef: CFTypeRef?
      if AXUIElementCopyAttributeValue(element, "AXFrame" as CFString, &frameRef) == .success,
         let axValue = frameRef, CFGetTypeID(axValue) == AXValueGetTypeID() {
        var frame = CGRect.zero
        AXValueGetValue(axValue as! AXValue, .cgRect, &frame)
        return frame
      }
    }

    var childrenRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
          let children = childrenRef as? [AXUIElement] else {
      return nil
    }

    for child in children {
      if let frame = findSimDisplayFrame(in: child) {
        return frame
      }
    }

    return nil
  }

  private static func findAXWindow(in app: AXUIElement, matching targetFrame: CGRect) -> AXUIElement? {
    var windowsRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsRef) == .success,
          let windows = windowsRef as? [AXUIElement] else {
      return nil
    }

    let tolerance: CGFloat = 2.0

    for window in windows {
      var positionRef: CFTypeRef?
      var sizeRef: CFTypeRef?
      guard
        AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &positionRef) == .success,
        AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeRef) == .success,
        let positionValue = positionRef, CFGetTypeID(positionValue) == AXValueGetTypeID(),
        let sizeValue = sizeRef, CFGetTypeID(sizeValue) == AXValueGetTypeID()
      else {
        continue
      }

      var position = CGPoint.zero
      var size = CGSize.zero
      AXValueGetValue(positionValue as! AXValue, .cgPoint, &position)
      AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)

      if abs(position.x - targetFrame.origin.x) <= tolerance,
         abs(position.y - targetFrame.origin.y) <= tolerance,
         abs(size.width - targetFrame.width) <= tolerance,
         abs(size.height - targetFrame.height) <= tolerance {
        return window
      }
    }

    return nil
  }
}

private func roundedCapturePixelDimension(_ value: CGFloat) -> Int {
  max(Int(value.rounded(.up)), 1)
}

private enum SimulatorControlSupport {
  static func runSimctl(arguments: [String], stdinData: Data? = nil) throws -> Data {
    let process = Process()
    let output = Pipe()
    let error = Pipe()

    process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
    process.arguments = ["simctl"] + arguments
    process.standardOutput = output
    process.standardError = error

    if let stdinData {
      let input = Pipe()
      process.standardInput = input
      try process.run()
      input.fileHandleForWriting.write(stdinData)
      try? input.fileHandleForWriting.close()
    } else {
      try process.run()
    }

    process.waitUntilExit()

    guard process.terminationStatus == 0 else {
      let stderr = String(data: error.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
      throw BridgeError.simctlCommandFailed(
        stderr?.isEmpty == false ? stderr! : "simctl \(arguments.joined(separator: " ")) failed."
      )
    }

    return output.fileHandleForReading.readDataToEndOfFile()
  }
}

@MainActor
private final class StatusCommandRunner {
  private let udid: String

  init(udid: String) {
    self.udid = udid
  }

  func run() async throws {
    let simulator = try SimulatorDiscovery.bootedSimulator(udid: udid)
    let resolved = try? await SimulatorDiscovery.resolveInteraction(udid: udid)
    let screenSize = DeviceProfile.screenSize(for: simulator.deviceTypeIdentifier)
    let deviceWidth = max(Int((screenSize?.width ?? CGFloat(resolved?.pixelWidth ?? 0)).rounded()), 1)
    let deviceHeight = max(Int((screenSize?.height ?? CGFloat(resolved?.pixelHeight ?? 0)).rounded()), 1)
    let preferredFramebufferSize = preferredFramebufferTargetPixelSize(screenSize: screenSize)
    let pixelWidth = max(
      resolved?.pixelWidth
        ?? (getIosSimulatorCaptureModePreference() == .framebuffer ? preferredFramebufferSize?.width : nil)
        ?? deviceWidth,
      1
    )
    let pixelHeight = max(
      resolved?.pixelHeight
        ?? (getIosSimulatorCaptureModePreference() == .framebuffer ? preferredFramebufferSize?.height : nil)
        ?? deviceHeight,
      1
    )
    #if canImport(FBControlCore) && canImport(FBSimulatorControl)
    let keyboardSyncState: KeyboardSyncState
    do {
      let nativeSession = try NativeSimulatorControlSession(udid: udid)
      keyboardSyncState = KeyboardSyncState(
        available: true,
        visible: nativeSession.currentSoftwareKeyboardVisible
      )
      nativeSession.disconnect()
    } catch {
      keyboardSyncState = KeyboardSyncState(available: false, visible: false)
    }
    #else
    let keyboardSyncState = KeyboardSyncState(available: false, visible: false)
    #endif
    let payload = SimulatorStatusPayload(
      session_info: .init(
        device_height: deviceHeight,
        device_width: deviceWidth,
        keyboard_sync_available: keyboardSyncState.available,
        pixel_height: pixelHeight,
        pixel_width: pixelWidth,
        software_keyboard_visible: keyboardSyncState.visible
      )
    )
    let data = try JSONEncoder().encode(payload)
    try FileHandle.standardOutput.write(contentsOf: data)
  }
}

private enum ControlMessageParser {
  static func parse(_ data: Data) throws -> ControlAction {
    guard
      let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let actionName = raw["action"] as? String
    else {
      throw BridgeError.invalidArguments("Invalid streamed control message.")
    }

    let payload = raw["payload"] as? [String: Any] ?? [:]

    switch actionName {
    case "tap":
      return .tap(
        x: try readNumber(payload, key: "x"),
        y: try readNumber(payload, key: "y")
      )
    case "touch":
      let phase = try readString(payload, key: "phase").lowercased()
      guard phase == "down" || phase == "move" || phase == "up" else {
        throw BridgeError.invalidArguments("touch requires phase down, move, or up.")
      }
      return .touch(
        x: try readNumber(payload, key: "x"),
        y: try readNumber(payload, key: "y"),
        phase: phase,
        edge: payload["edge"] as? String
      )
    case "drag":
      let phase = try readString(payload, key: "phase").lowercased()
      guard phase == "start" || phase == "move" || phase == "end" else {
        throw BridgeError.invalidArguments("drag requires phase start, move, or end.")
      }
      return .drag(
        phase: phase,
        points: try readDragPoints(payload, key: "points")
      )
    case "swipe":
      return .swipe(
        startX: try readNumber(payload, key: "start_x"),
        startY: try readNumber(payload, key: "start_y"),
        endX: try readNumber(payload, key: "end_x"),
        endY: try readNumber(payload, key: "end_y"),
        duration: min(max(readOptionalNumber(payload, key: "duration") ?? 0.2, 0.08), 0.8),
        delta: readOptionalNumber(payload, key: "delta")
      )
    case "text":
      return .text(try readString(payload, key: "text"))
    case "key":
      return .key(
        try readString(payload, key: "key"),
        duration: readOptionalNumber(payload, key: "duration")
      )
    case "button":
      return .button(try readString(payload, key: "button"))
    case "system":
      return .systemGesture(try readString(payload, key: "name"))
    default:
      throw BridgeError.invalidArguments("Unsupported streamed control action: \(actionName)")
    }
  }

  private static func readNumber(_ payload: [String: Any], key: String) throws -> Double {
    if let value = payload[key] as? NSNumber {
      return value.doubleValue
    }
    if let value = payload[key] as? String, let parsed = Double(value) {
      return parsed
    }
    throw BridgeError.invalidArguments("Missing numeric streamed control field: \(key)")
  }

  private static func readOptionalNumber(_ payload: [String: Any], key: String) -> Double? {
    if let value = payload[key] as? NSNumber {
      return value.doubleValue
    }
    if let value = payload[key] as? String {
      return Double(value)
    }
    return nil
  }

  private static func readString(_ payload: [String: Any], key: String) throws -> String {
    if let value = payload[key] as? String, value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
      return value
    }
    throw BridgeError.invalidArguments("Missing string streamed control field: \(key)")
  }

  private static func readDragPoints(_ payload: [String: Any], key: String) throws -> [DragPathPoint] {
    guard let rawPoints = payload[key] as? [[String: Any]] else {
      throw BridgeError.invalidArguments("Missing drag points array.")
    }

    return try rawPoints.map { rawPoint in
      DragPathPoint(
        delayMs: max(readOptionalNumber(rawPoint, key: "delay_ms") ?? 0, 0),
        x: try readNumber(rawPoint, key: "x"),
        y: try readNumber(rawPoint, key: "y")
      )
    }
  }
}

private final class SimulatorControlExecutor {
  private let udid: String
  private let axeExecutableURL: URL
  var onKeyboardSyncStateChange: ((KeyboardSyncState) -> Void)?
  #if canImport(FBControlCore) && canImport(FBSimulatorControl)
  private var nativeControlUnavailableReason: String?
  private var nativeSession: NativeSimulatorControlSession?
  #endif

  init(udid: String) {
    self.udid = udid
    self.axeExecutableURL = SimulatorControlExecutor.resolveAxeExecutableURL()
  }

  var currentKeyboardSyncState: KeyboardSyncState {
    #if canImport(FBControlCore) && canImport(FBSimulatorControl)
    if let nativeSession {
      return KeyboardSyncState(
        available: true,
        visible: nativeSession.currentSoftwareKeyboardVisible
      )
    }
    #endif

    return KeyboardSyncState(available: false, visible: false)
  }

  func prepareForStreaming() {
    #if canImport(FBControlCore) && canImport(FBSimulatorControl)
    guard nativeSession == nil, nativeControlUnavailableReason == nil else {
      onKeyboardSyncStateChange?(currentKeyboardSyncState)
      return
    }

    do {
      nativeSession = try NativeSimulatorControlSession(udid: udid)
      StderrLogger.log("SimulatorBridge native HID control ready (\(udid)).")
    } catch {
      nativeControlUnavailableReason = error.localizedDescription
      StderrLogger.log("SimulatorBridge falling back to axe control for \(udid): \(error.localizedDescription)")
    }
    #endif

    onKeyboardSyncStateChange?(currentKeyboardSyncState)
  }

  func stop() {
    #if canImport(FBControlCore) && canImport(FBSimulatorControl)
    nativeSession?.disconnect()
    nativeSession = nil
    #endif
  }

  func perform(_ action: ControlAction) throws {
    if case .systemGesture(let gesture) = action {
      try performSystemGesture(gesture)
      return
    }

    prepareForStreaming()

    #if canImport(FBControlCore) && canImport(FBSimulatorControl)
    if let nativeSession, nativeSession.canHandle(action) {
      try nativeSession.perform(action)
      return
    }
    #endif

    switch action {
    case .tap(let x, let y):
      try performTap(x: x, y: y)
    case .touch(let x, let y, let phase, let edge):
      try performTouch(x: x, y: y, phase: phase, edge: edge)
    case .drag(let phase, let points):
      try performDrag(phase: phase, points: points)
    case .swipe(let startX, let startY, let endX, let endY, let duration, let delta):
      try performSwipe(
        startX: startX,
        startY: startY,
        endX: endX,
        endY: endY,
        duration: duration,
        delta: delta
      )
    case .text(let text):
      try performText(text)
    case .key(let key, let duration):
      try performNamedKey(key, duration: duration)
    case .button(let button):
      try performButton(button)
    case .systemGesture:
      break
    }
  }

  private func runAxe(arguments: [String]) throws {
    let process = Process()
    let error = Pipe()

    process.executableURL = axeExecutableURL
    process.arguments = arguments
    process.standardError = error

    try process.run()
    process.waitUntilExit()

    guard process.terminationStatus == 0 else {
      let stderr = String(data: error.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
      let detail = stderr?.isEmpty == false ? stderr! : "axe exited with status \(process.terminationStatus)"
      throw BridgeError.invalidArguments(detail)
    }
  }

  private func coordinateString(_ value: Double) -> String {
    String(Int(max(value.rounded(), 0)))
  }

  private static func resolveAxeExecutableURL() -> URL {
    let candidates = [
      "/opt/homebrew/bin/axe",
      "/usr/local/bin/axe",
    ]

    for candidate in candidates {
      if FileManager.default.isExecutableFile(atPath: candidate) {
        return URL(fileURLWithPath: candidate)
      }
    }

    return URL(fileURLWithPath: candidates[0])
  }

  private func performTap(x: Double, y: Double) throws {
    try runAxe(arguments: [
      "tap",
      "-x",
      coordinateString(x),
      "-y",
      coordinateString(y),
      "--udid",
      udid,
    ])
  }

  private func performTouch(x: Double, y: Double, phase: String, edge: String?) throws {
    var arguments = [
      "touch",
      "-x",
      coordinateString(x),
      "-y",
      coordinateString(y),
    ]
    if phase == "down" || phase == "move" {
      arguments.append("--down")
    } else {
      arguments.append("--up")
    }
    arguments += [
      "--udid",
      udid,
    ]

    try runAxe(arguments: arguments)

    if edge != nil {
      StderrLogger.log("SimulatorBridge edge touch fallback in use for \(udid); native edge semantics unavailable.")
    }
  }

  private func performDrag(phase: String, points: [DragPathPoint]) throws {
    var arguments = [
      "batch",
      "--udid",
      udid,
    ]

    var remainingPoints = points
    if (phase == "start" || phase == "move"), let firstPoint = remainingPoints.first {
      arguments += [
        "--step",
        "touch -x \(coordinateString(firstPoint.x)) -y \(coordinateString(firstPoint.y)) --down",
      ]
      remainingPoints.removeFirst()
    }

    for point in remainingPoints {
      if point.delayMs > 0 {
        arguments += ["--step", "sleep \(String(format: "%.4f", point.delayMs / 1000))"]
      }
      let touchPhase = phase == "end" && point.x == remainingPoints.last?.x && point.y == remainingPoints.last?.y
        ? "--up"
        : "--down"
      arguments += [
        "--step",
        "touch -x \(coordinateString(point.x)) -y \(coordinateString(point.y)) \(touchPhase)",
      ]
    }

    if phase == "end", let lastPoint = points.last {
      let hasUpStep = arguments.contains { $0.contains("--up") }
      if !hasUpStep {
        arguments += [
          "--step",
          "touch -x \(coordinateString(lastPoint.x)) -y \(coordinateString(lastPoint.y)) --up",
        ]
      }
    }

    try runAxe(arguments: arguments)
  }

  private func performSwipe(
    startX: Double,
    startY: Double,
    endX: Double,
    endY: Double,
    duration: Double,
    delta: Double?
  ) throws {
    var arguments = [
      "swipe",
      "--start-x",
      coordinateString(startX),
      "--start-y",
      coordinateString(startY),
      "--end-x",
      coordinateString(endX),
      "--end-y",
      coordinateString(endY),
      "--duration",
      String(min(max(duration, 0.08), 0.8)),
    ]
    if let delta {
      arguments += ["--delta", String(min(max(delta, 2), 12))]
    }
    arguments += [
      "--udid",
      udid,
    ]

    try runAxe(arguments: arguments)
  }

  private func performText(_ text: String) throws {
    try runAxe(arguments: [
      "type",
      text,
      "--udid",
      udid,
    ])
  }

  private func performNamedKey(_ key: String, duration: Double?) throws {
    let hidKeyCode: Int

    switch key.uppercased() {
    case "DELETE", "BACKSPACE":
      hidKeyCode = 42
    case "RETURN", "ENTER":
      hidKeyCode = 40
    case "TAB":
      hidKeyCode = 43
    case "ESCAPE":
      hidKeyCode = 41
    default:
      throw BridgeError.invalidArguments("Unsupported simulator key: \(key)")
    }

    var arguments = [
      "key",
      String(hidKeyCode),
    ]
    if let duration {
      arguments += ["--duration", String(duration)]
    }
    arguments += ["--udid", udid]
    try runAxe(arguments: arguments)
  }

  private func performButton(_ button: String) throws {
    let axeButton: String
    switch button.lowercased() {
    case "home", "lock":
      axeButton = button.lowercased()
    case "side":
      axeButton = "side-button"
    default:
      throw BridgeError.invalidArguments("Unsupported simulator button: \(button)")
    }
    try runAxe(arguments: [
      "button",
      axeButton,
      "--udid",
      udid,
    ])
  }

  private func postSimulatorNotification(name: String, userInfo: [String: Any]? = nil) {
    DistributedNotificationCenter.default().post(
      name: Notification.Name(name),
      object: nil,
      userInfo: userInfo
    )
  }

  private func performSystemGesture(_ gesture: String) throws {
    switch gesture.lowercased() {
    case "shake":
      prepareForStreaming()
      #if canImport(FBControlCore) && canImport(FBSimulatorControl)
      if let nativeSession {
        do {
          try nativeSession.performSystemGesture("shake")
          return
        } catch {
          StderrLogger.log("SimulatorBridge native shake fallback for \(udid): \(error.localizedDescription)")
        }
      }
      #endif
      postSimulatorNotification(name: "com.apple.UIKit.SimulatorShake")
    case "show_keyboard", "hide_keyboard":
      prepareForStreaming()
      #if canImport(FBControlCore) && canImport(FBSimulatorControl)
      if let nativeSession {
        try nativeSession.performSystemGesture(gesture)
        onKeyboardSyncStateChange?(currentKeyboardSyncState)
        return
      }
      #endif
      throw BridgeError.invalidArguments(
        "Simulator software keyboard control requires native simulator access."
      )
    case "swipe_home", "app_switcher":
      prepareForStreaming()
      #if canImport(FBControlCore) && canImport(FBSimulatorControl)
      if let nativeSession {
        try nativeSession.performSystemGesture(gesture)
        return
      }
      #endif
      throw BridgeError.invalidArguments(
        "Simulator system gesture \(gesture) requires native simulator access."
      )
    default:
      throw BridgeError.invalidArguments("Unsupported native simulator system gesture: \(gesture)")
    }
  }
}

#if canImport(FBControlCore) && canImport(FBSimulatorControl)
private enum SimulatorAppPrivateCategoryLoader {
  private static var attemptedLoad = false

  static func ensureLoaded() {
    guard attemptedLoad == false else {
      return
    }
    attemptedLoad = true

    for candidate in simulatorExecutableCandidates() {
      if dlopen(candidate, RTLD_NOW | RTLD_GLOBAL) != nil {
        StderrLogger.log("SimulatorBridge loaded Simulator private categories from \(candidate).")
        return
      }
    }

    let details = simulatorExecutableCandidates().joined(separator: ", ")
    StderrLogger.log("SimulatorBridge could not load Simulator private categories. Checked: \(details)")
  }

  private static func simulatorExecutableCandidates() -> [String] {
    var candidates: [String] = []

    func appendDeveloperDir(_ value: String?) {
      guard let value else {
        return
      }
      let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
      guard trimmed.isEmpty == false else {
        return
      }

      candidates.append("\(trimmed)/Applications/Simulator.app/Contents/MacOS/Simulator")
    }

    appendDeveloperDir(ProcessInfo.processInfo.environment["DEVELOPER_DIR"])
    appendDeveloperDir(ProcessInfo.processInfo.environment["XCODE_DEVELOPER_DIR_PATH"])
    appendDeveloperDir(resolveDeveloperDirUsingXcodeSelect())

    return Array(NSOrderedSet(array: candidates)) as? [String] ?? candidates
  }

  private static func resolveDeveloperDirUsingXcodeSelect() -> String? {
    let process = Process()
    let output = Pipe()

    process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
    process.arguments = ["-p"]
    process.standardOutput = output
    process.standardError = Pipe()

    do {
      try process.run()
      process.waitUntilExit()
    } catch {
      return nil
    }

    guard process.terminationStatus == 0 else {
      return nil
    }

    return String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

private final class NativeSimulatorControlSession {
  private let hid: FBSimulatorHID
  private let control: FBSimulatorControl
  private let privateHIDBridge: PrivateSimulatorHIDBridge?
  private let simulator: FBSimulator
  private let udid: String
  private var activeDragPoint: DragPathPoint?
  private var softwareKeyboardVisible: Bool

  init(udid: String) throws {
    self.udid = udid
    FBSimulatorControlFrameworkLoader.xcodeFrameworks.loadPrivateFrameworksOrAbort()

    let configuration = FBSimulatorControlConfiguration(deviceSetPath: nil, logger: nil, reporter: nil)
    self.control = try FBSimulatorControl.withConfiguration(configuration)
    guard let simulator = control.set.simulator(withUDID: udid) else {
      throw BridgeError.simulatorNotBooted(udid)
    }
    self.simulator = simulator
    self.hid = try FBSimulatorHID.hid(for: simulator).await(withTimeout: 5)
    if let device = simulator.perform(NSSelectorFromString("device"))?.takeUnretainedValue() as? NSObject {
      self.privateHIDBridge = try? PrivateSimulatorHIDBridge(device: device)
      self.softwareKeyboardVisible = Self.resolveSoftwareKeyboardVisible(on: device)
    } else {
      self.privateHIDBridge = nil
      self.softwareKeyboardVisible = false
    }
  }

  func canHandle(_ action: ControlAction) -> Bool {
    switch action {
    case .tap, .touch, .drag, .swipe, .key, .button:
      return true
    case .text, .systemGesture:
      return false
    }
  }

  var currentSoftwareKeyboardVisible: Bool {
    softwareKeyboardVisible
  }

  func perform(_ action: ControlAction) throws {
    switch action {
    case .tap(let x, let y):
      _ = try FBSimulatorHIDEvent.tapAt(x: x, y: y).perform(on: hid).await(withTimeout: 5)
    case .touch(let x, let y, let phase, let edge):
      let edgeValue = PrivateSimulatorHIDBridge.edgeValue(for: edge)
      if let privateHIDBridge, (edgeValue != PrivateSimulatorHIDBridge.edgeNone || phase == "move") {
        try privateHIDBridge.sendTouch(phase: phase, x: x, y: y, edge: edgeValue)
        activeDragPoint = phase == "up" ? nil : DragPathPoint(delayMs: 0, x: x, y: y)
        return
      }

      let event: FBSimulatorHIDEvent
      switch phase {
      case "down", "move":
        event = FBSimulatorHIDEvent.touchDownAt(x: x, y: y)
      case "up":
        event = FBSimulatorHIDEvent.touchUpAt(x: x, y: y)
      default:
        throw BridgeError.invalidArguments("Unsupported simulator touch phase: \(phase)")
      }
      _ = try event.perform(on: hid).await(withTimeout: 5)
      activeDragPoint = phase == "up" ? nil : DragPathPoint(delayMs: 0, x: x, y: y)
    case .drag(let phase, let points):
      try performDrag(phase: phase, points: points)
    case .swipe(let startX, let startY, let endX, let endY, let duration, let delta):
      _ = try FBSimulatorHIDEvent.swipe(
        startX,
        yStart: startY,
        xEnd: endX,
        yEnd: endY,
        delta: min(max(delta ?? DEFAULT_SWIPE_DELTA, 2), 12),
        duration: duration
      ).perform(on: hid).await(withTimeout: 5)
      activeDragPoint = nil
    case .text:
      break
    case .key(let key, let duration):
      let keyCode = try hidKeyCode(for: key)
      _ = try hid.sendKeyboardEvent(with: .down, keyCode: keyCode).await(withTimeout: 5)
      if let duration {
        Thread.sleep(forTimeInterval: max(duration, 0))
      }
      _ = try hid.sendKeyboardEvent(with: .up, keyCode: keyCode).await(withTimeout: 5)
    case .button(let button):
      let hidButton = try buttonValue(for: button)
      try pressButton(hidButton)
    case .systemGesture(let gesture):
      throw BridgeError.invalidArguments("Unsupported native simulator system gesture: \(gesture)")
    }
  }

  func performSystemGesture(_ gesture: String) throws {
    switch gesture.lowercased() {
    case "shake":
      try performNativeShake()
    case "show_keyboard":
      try setSoftwareKeyboardVisible(true)
    case "hide_keyboard":
      try setSoftwareKeyboardVisible(false)
    case "swipe_home":
      if let privateHIDBridge {
        try privateHIDBridge.sendSwipeHome()
        return
      }
      try pressButton(.homeButton)
    case "app_switcher":
      if let privateHIDBridge {
        try privateHIDBridge.sendAppSwitcher()
        return
      }
      try pressButton(.homeButton)
      Thread.sleep(forTimeInterval: 0.15)
      try pressButton(.homeButton)
    default:
      throw BridgeError.invalidArguments("Unsupported native simulator system gesture: \(gesture)")
    }
  }

  func disconnect() {
    activeDragPoint = nil
    do {
      _ = try hid.disconnect().await(withTimeout: 5)
    } catch {
      StderrLogger.log("SimulatorBridge native HID disconnect failed for \(udid): \(error.localizedDescription)")
    }
    _ = control
    _ = simulator
  }

  private func hidKeyCode(for key: String) throws -> UInt32 {
    switch key.uppercased() {
    case "DELETE", "BACKSPACE":
      return 42
    case "RETURN", "ENTER":
      return 40
    case "TAB":
      return 43
    case "ESCAPE":
      return 41
    default:
      throw BridgeError.invalidArguments("Unsupported simulator key: \(key)")
    }
  }

  private func buttonValue(for button: String) throws -> FBSimulatorHIDButton {
    switch button.lowercased() {
    case "home":
      return .homeButton
    case "lock":
      return .lock
    case "side":
      return .sideButton
    default:
      throw BridgeError.invalidArguments("Unsupported simulator button: \(button)")
    }
  }

  private func pressButton(_ button: FBSimulatorHIDButton) throws {
    _ = try hid.sendButtonEvent(with: .down, button: button).await(withTimeout: 5)
    _ = try hid.sendButtonEvent(with: .up, button: button).await(withTimeout: 5)
  }

  private func performDrag(phase: String, points: [DragPathPoint]) throws {
    var events: [FBSimulatorHIDEvent] = []
    var remainingPoints = points

    if (phase == "start" || activeDragPoint == nil), let firstPoint = remainingPoints.first {
      events.append(FBSimulatorHIDEvent.touchDownAt(x: firstPoint.x, y: firstPoint.y))
      activeDragPoint = firstPoint
      remainingPoints.removeFirst()
    }

    for point in remainingPoints {
      if point.delayMs > 0 {
        events.append(FBSimulatorHIDEvent.delay(point.delayMs / 1000))
      }
      events.append(FBSimulatorHIDEvent.touchDownAt(x: point.x, y: point.y))
      activeDragPoint = point
    }

    if phase == "end", let endPoint = activeDragPoint ?? points.last {
      events.append(FBSimulatorHIDEvent.touchUpAt(x: endPoint.x, y: endPoint.y))
      activeDragPoint = nil
    }

    guard !events.isEmpty else {
      return
    }

    let event = events.count == 1
      ? events[0]
      : FBSimulatorHIDEvent(events: events)
    _ = try event.perform(on: hid).await(withTimeout: 5)
  }

  private func performNativeShake() throws {
    SimulatorAppPrivateCategoryLoader.ensureLoaded()

    guard let device = simulator.perform(NSSelectorFromString("device"))?.takeUnretainedValue() as AnyObject? else {
      throw BridgeError.invalidArguments("Unable to resolve the underlying simulator device for shake.")
    }
    if try postNativeDarwinNotification(
      on: device,
      name: "com.apple.UIKit.SimulatorShake"
    ) {
      return
    }
    let selector = NSSelectorFromString("simulateShake")
    guard device.responds(to: selector) else {
      throw BridgeError.invalidArguments("Simulator private shake API is unavailable.")
    }

    _ = device.perform(selector)
  }

  private func postNativeDarwinNotification(on device: AnyObject, name: String) throws -> Bool {
    let selector = NSSelectorFromString("postDarwinNotification:error:")
    guard device.responds(to: selector) else {
      return false
    }

    typealias PostDarwinNotification = @convention(c) (
      AnyObject,
      Selector,
      NSString,
      UnsafeMutablePointer<NSError?>?
    ) -> Bool

    let implementation = unsafeBitCast(device.method(for: selector), to: PostDarwinNotification.self)
    var error: NSError?
    let succeeded = implementation(device, selector, name as NSString, &error)
    if let error {
      throw error
    }

    return succeeded
  }

  private func setSoftwareKeyboardVisible(_ visible: Bool) throws {
    SimulatorAppPrivateCategoryLoader.ensureLoaded()

    guard let device = simulator.perform(NSSelectorFromString("device"))?.takeUnretainedValue() as AnyObject? else {
      throw BridgeError.invalidArguments("Unable to resolve the underlying simulator device for keyboard control.")
    }

    let selector = NSSelectorFromString("setHardwareKeyboardEnabled:keyboardType:error:")
    guard device.responds(to: selector) else {
      throw BridgeError.invalidArguments("Simulator hardware keyboard API is unavailable.")
    }

    typealias SetHardwareKeyboardEnabled = @convention(c) (
      AnyObject,
      Selector,
      Bool,
      UInt8,
      UnsafeMutablePointer<NSError?>?
    ) -> Bool

    let implementation = unsafeBitCast(device.method(for: selector), to: SetHardwareKeyboardEnabled.self)
    var error: NSError?
    let succeeded = implementation(
      device,
      selector,
      !visible,
      SIMULATOR_HARDWARE_KEYBOARD_TYPE_DEFAULT,
      &error
    )
    if let error {
      throw error
    }
    guard succeeded else {
      throw BridgeError.invalidArguments("Simulator keyboard toggle was rejected.")
    }
    softwareKeyboardVisible = visible
  }

  private static func readBoolSelector(on object: AnyObject, selectorNames: [String]) -> Bool? {
    typealias BoolGetter = @convention(c) (AnyObject, Selector) -> Bool

    for selectorName in selectorNames {
      let selector = NSSelectorFromString(selectorName)
      guard object.responds(to: selector) else {
        continue
      }

      let implementation = unsafeBitCast(object.method(for: selector), to: BoolGetter.self)
      return implementation(object, selector)
    }

    return nil
  }

  private static func resolveSoftwareKeyboardVisible(on device: NSObject) -> Bool {
    if let hardwareKeyboardEnabled = readBoolSelector(
      on: device,
      selectorNames: ["hardwareKeyboardEnabled", "isHardwareKeyboardEnabled"]
    ) {
      return !hardwareKeyboardEnabled
    }

    return false
  }
}
#endif

@MainActor
private final class ControlCommandRunner {
  private let action: ControlAction
  private let udid: String
  private let executor: SimulatorControlExecutor

  init(command: ControlCommand) {
    self.action = command.action
    self.udid = command.udid
    self.executor = SimulatorControlExecutor(udid: command.udid)
  }

  func run() async throws {
    _ = try SimulatorDiscovery.bootedSimulator(udid: udid)
    try executor.perform(action)
  }
}

private final class H264Encoder: StreamVideoEncoder {
  private let metadataObserver: (StreamMetadata) -> Void
  private let metadataStateProvider: () -> KeyboardSyncState
  private let writer: PacketWriter
  private let deviceName: String
  private let fps: Int
  private let pointHeight: Int
  private let pointWidth: Int
  private let udid: String
  private let ciContext = CIContext()
  private let colorSpace = CGColorSpaceCreateDeviceRGB()

  private var compressionSession: VTCompressionSession?
  private var currentHeight = 0
  private var currentWidth = 0
  private var frameIndex: Int64 = 0
  private var lastCodec = ""
  private var lastMetadataSignature = ""
  private var pendingForcedKeyFrame = true
  private var scaledBufferHeight = 0
  private var scaledBufferPool: CVPixelBufferPool?
  private var scaledBufferWidth = 0
  private var targetPixelHeight: Int?
  private var targetPixelWidth: Int?

  init(
    deviceName: String,
    fps: Int,
    pointHeight: Int,
    pointWidth: Int,
    udid: String,
    writer: PacketWriter,
    metadataStateProvider: @escaping () -> KeyboardSyncState,
    metadataObserver: @escaping (StreamMetadata) -> Void
  ) {
    self.deviceName = deviceName
    self.fps = fps
    self.metadataObserver = metadataObserver
    self.metadataStateProvider = metadataStateProvider
    self.pointHeight = pointHeight
    self.pointWidth = pointWidth
    self.udid = udid
    self.writer = writer
  }

  func encode(sampleBuffer: CMSampleBuffer, capturedAtMs: UInt64) throws {
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
      return
    }

    let preparedPixelBuffer = try preparedPixelBuffer(for: pixelBuffer)
    try encode(
      pixelBuffer: preparedPixelBuffer,
      presentationTimeStamp: CMSampleBufferGetPresentationTimeStamp(sampleBuffer),
      duration: CMSampleBufferGetDuration(sampleBuffer),
      capturedAtMs: capturedAtMs
    )
  }

  func encode(pixelBuffer: CVPixelBuffer, capturedAtMs: UInt64, changeRatio _: Double?) throws {
    frameIndex += 1
    let safeFps = max(fps, 1)
    let preparedPixelBuffer = try preparedPixelBuffer(for: pixelBuffer)
    try encode(
      pixelBuffer: preparedPixelBuffer,
      presentationTimeStamp: CMTime(value: frameIndex, timescale: CMTimeScale(safeFps)),
      duration: CMTime(value: 1, timescale: CMTimeScale(safeFps)),
      capturedAtMs: capturedAtMs
    )
  }

  func updateTargetPixelSize(height: Int?, width: Int?) {
    targetPixelHeight = height
    targetPixelWidth = width
    scaledBufferPool = nil
    scaledBufferHeight = 0
    scaledBufferWidth = 0
  }

  func encode(pixelBuffer: CVPixelBuffer, presentationTimeStamp: CMTime, duration: CMTime, capturedAtMs: UInt64) throws {
    let width = CVPixelBufferGetWidth(pixelBuffer)
    let height = CVPixelBufferGetHeight(pixelBuffer)
    try ensureCompressionSession(width: width, height: height)

    guard let compressionSession else {
      throw BridgeError.failedToCreateEncoder
    }

    let status = VTCompressionSessionEncodeFrame(
      compressionSession,
      imageBuffer: pixelBuffer,
      presentationTimeStamp: presentationTimeStamp,
      duration: duration,
      frameProperties: pendingForcedKeyFrame
        ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
        : nil,
      sourceFrameRefcon: Unmanaged.passRetained(EncodedFrameContext(capturedAtMs: capturedAtMs)).toOpaque(),
      infoFlagsOut: nil
    )

    guard status == noErr else {
      throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
    }

    pendingForcedKeyFrame = false
  }

  func finish() {
    guard let compressionSession else {
      return
    }

    VTCompressionSessionCompleteFrames(compressionSession, untilPresentationTimeStamp: .invalid)
    VTCompressionSessionInvalidate(compressionSession)
    self.compressionSession = nil
  }

  private func ensureCompressionSession(width: Int, height: Int) throws {
    guard compressionSession == nil || currentWidth != width || currentHeight != height else {
      return
    }

    finish()

    currentWidth = width
    currentHeight = height
    frameIndex = 0
    pendingForcedKeyFrame = true

    let callback: VTCompressionOutputCallback = { outputRefCon, sourceFrameRefCon, status, _, sampleBuffer in
      let frameContext = sourceFrameRefCon.map {
        Unmanaged<EncodedFrameContext>.fromOpaque($0).takeRetainedValue()
      }
      guard
        status == noErr,
        let outputRefCon,
        let sampleBuffer
      else {
        if status != noErr {
          StderrLogger.log("VTCompressionSession callback failed with status \(status).")
        }
        return
      }

      let encoder = Unmanaged<H264Encoder>.fromOpaque(outputRefCon).takeUnretainedValue()
      do {
        try encoder.handleEncoded(sampleBuffer: sampleBuffer, capturedAtMs: frameContext?.capturedAtMs ?? 0)
      } catch {
        StderrLogger.log(error.localizedDescription)
      }
    }

    var newSession: VTCompressionSession?
    let encoderSpecification: CFDictionary = [
      kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: kCFBooleanTrue as Any
    ] as CFDictionary
    let status = VTCompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      width: Int32(width),
      height: Int32(height),
      codecType: kCMVideoCodecType_H264,
      encoderSpecification: encoderSpecification,
      imageBufferAttributes: nil,
      compressedDataAllocator: nil,
      outputCallback: callback,
      refcon: Unmanaged.passUnretained(self).toOpaque(),
      compressionSessionOut: &newSession
    )

    guard status == noErr, let newSession else {
      throw BridgeError.failedToCreateEncoder
    }

    compressionSession = newSession

    setCompressionProperty(newSession, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    setCompressionProperty(newSession, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    setCompressionProperty(newSession, key: kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, value: kCFBooleanTrue)
    setCompressionProperty(newSession, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel)
    setCompressionProperty(newSession, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: fps as CFTypeRef)
    setCompressionProperty(newSession, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: 1 as CFTypeRef)
    setCompressionProperty(newSession, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFTypeRef)

    let entropyMode = kVTH264EntropyMode_CAVLC as CFTypeRef
    setCompressionProperty(newSession, key: kVTCompressionPropertyKey_H264EntropyMode, value: entropyMode)
    setCompressionProperty(newSession, key: kVTCompressionPropertyKey_Quality, value: NSNumber(value: 1.0))

    let averageBitrate = NSNumber(value: max(width * height * 14, 8_000_000))
    setCompressionProperty(newSession, key: kVTCompressionPropertyKey_AverageBitRate, value: averageBitrate)

    let dataRateLimits: [NSNumber] = [
      NSNumber(value: max(width * height * 18, 12_000_000)),
      1,
    ]
    setCompressionProperty(newSession, key: kVTCompressionPropertyKey_DataRateLimits, value: dataRateLimits as CFArray)

    VTCompressionSessionPrepareToEncodeFrames(newSession)
  }

  private func preparedPixelBuffer(for pixelBuffer: CVPixelBuffer) throws -> CVPixelBuffer {
    guard
      let requestedWidth = targetPixelWidth,
      let requestedHeight = targetPixelHeight,
      requestedWidth > 0,
      requestedHeight > 0
    else {
      return pixelBuffer
    }

    let sourceWidth = CVPixelBufferGetWidth(pixelBuffer)
    let sourceHeight = CVPixelBufferGetHeight(pixelBuffer)
    guard sourceWidth > 0, sourceHeight > 0 else {
      return pixelBuffer
    }

    let widthScale = CGFloat(requestedWidth) / CGFloat(sourceWidth)
    let heightScale = CGFloat(requestedHeight) / CGFloat(sourceHeight)
    let scale = min(widthScale, heightScale, 1)
    guard scale < 0.999 else {
      return pixelBuffer
    }

    let outputWidth = max(Int((CGFloat(sourceWidth) * scale).rounded()), 1)
    let outputHeight = max(Int((CGFloat(sourceHeight) * scale).rounded()), 1)
    let outputPixelBuffer = try makeScaledPixelBuffer(width: outputWidth, height: outputHeight)
    let image = CIImage(cvPixelBuffer: pixelBuffer)
      .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    ciContext.render(
      image,
      to: outputPixelBuffer,
      bounds: CGRect(x: 0, y: 0, width: outputWidth, height: outputHeight),
      colorSpace: colorSpace
    )
    return outputPixelBuffer
  }

  private func makeScaledPixelBuffer(width: Int, height: Int) throws -> CVPixelBuffer {
    if scaledBufferPool == nil || scaledBufferWidth != width || scaledBufferHeight != height {
      scaledBufferPool = nil
      scaledBufferWidth = width
      scaledBufferHeight = height

      let attributes: CFDictionary = [
        kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey: width,
        kCVPixelBufferHeightKey: height,
        kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
      ] as CFDictionary

      var newPool: CVPixelBufferPool?
      let status = CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attributes, &newPool)
      guard status == kCVReturnSuccess, let newPool else {
        throw BridgeError.failedToCreateEncoder
      }
      scaledBufferPool = newPool
    }

    guard let scaledBufferPool else {
      throw BridgeError.failedToCreateEncoder
    }

    var pixelBuffer: CVPixelBuffer?
    let status = CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, scaledBufferPool, &pixelBuffer)
    guard status == kCVReturnSuccess, let pixelBuffer else {
      throw BridgeError.failedToCreateEncoder
    }

    return pixelBuffer
  }

  private func setCompressionProperty(_ session: VTCompressionSession, key: CFString, value: CFTypeRef) {
    let status = VTSessionSetProperty(session, key: key, value: value)
    guard status != noErr else {
      return
    }

    StderrLogger.log("VTSessionSetProperty \(key) failed with status \(status).")
  }

  private func handleEncoded(sampleBuffer: CMSampleBuffer, capturedAtMs: UInt64) throws {
    guard CMSampleBufferDataIsReady(sampleBuffer),
          let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer) else {
      return
    }

    let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
    let keyFrame = !attachmentContainsNotSync(attachments)

    try maybeSendFormatDescription(formatDescription)
    let payload = try annexBPayload(from: sampleBuffer)
    try writer.sendFrame(type: keyFrame ? .keyFrame : .deltaFrame, payload: payload, capturedAtMs: capturedAtMs)
  }

  private func maybeSendFormatDescription(_ formatDescription: CMFormatDescription) throws {
    var parameterSetCount = 0
    var status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
      formatDescription,
      parameterSetIndex: 0,
      parameterSetPointerOut: nil,
      parameterSetSizeOut: nil,
      parameterSetCountOut: &parameterSetCount,
      nalUnitHeaderLengthOut: nil
    )

    guard status == noErr, parameterSetCount > 0 else {
      return
    }

    var configPayload = Data()
    var codec: String?

    for index in 0..<parameterSetCount {
      var parameterPointer: UnsafePointer<UInt8>?
      var parameterSize = 0
      var nalHeaderLength: Int32 = 0
      status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        formatDescription,
        parameterSetIndex: index,
        parameterSetPointerOut: &parameterPointer,
        parameterSetSizeOut: &parameterSize,
        parameterSetCountOut: &parameterSetCount,
        nalUnitHeaderLengthOut: &nalHeaderLength
      )

      guard status == noErr, let parameterPointer, parameterSize > 0 else {
        continue
      }

      let parameterData = Data(bytes: parameterPointer, count: parameterSize)
      if index == 0, parameterData.count >= 4 {
        codec = String(format: "avc1.%02X%02X%02X", parameterData[1], parameterData[2], parameterData[3])
      }

      configPayload.append(contentsOf: [0, 0, 0, 1])
      configPayload.append(parameterData)
    }

    guard let codec else {
      return
    }

    let metadataSignature = "\(codec):\(currentWidth)x\(currentHeight)"
    if codec != lastCodec || metadataSignature != lastMetadataSignature {
      lastCodec = codec
      lastMetadataSignature = metadataSignature
      let keyboardSyncState = metadataStateProvider()
      let metadata = StreamMetadata(
        codec: codec,
        deviceName: deviceName,
        keyboardSyncAvailable: keyboardSyncState.available,
        pointHeight: pointHeight,
        pointWidth: pointWidth,
        pixelHeight: currentHeight,
        pixelWidth: currentWidth,
        softwareKeyboardVisible: keyboardSyncState.visible,
        udid: udid
      )
      metadataObserver(metadata)
      try writer.sendJSON(metadata)
    }

    if configPayload.isEmpty == false {
      try writer.send(type: .config, payload: configPayload)
    }
  }

  private func annexBPayload(from sampleBuffer: CMSampleBuffer) throws -> Data {
    guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else {
      return Data()
    }

    let totalLength = CMBlockBufferGetDataLength(dataBuffer)
    var data = Data(count: totalLength)
    let status = data.withUnsafeMutableBytes { destination in
      CMBlockBufferCopyDataBytes(
        dataBuffer,
        atOffset: 0,
        dataLength: totalLength,
        destination: destination.baseAddress!
      )
    }

    guard status == kCMBlockBufferNoErr else {
      throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
    }

    var annexB = Data()
    var offset = 0

    while offset + 4 <= data.count {
      let nalLength = data[offset..<(offset + 4)].reduce(0) { ($0 << 8) | Int($1) }
      offset += 4

      guard nalLength > 0, offset + nalLength <= data.count else {
        break
      }

      annexB.append(contentsOf: [0, 0, 0, 1])
      annexB.append(data[offset..<(offset + nalLength)])
      offset += nalLength
    }

    return annexB
  }

  private func attachmentContainsNotSync(_ attachments: CFArray?) -> Bool {
    guard
      let attachments,
      CFArrayGetCount(attachments) > 0,
      let first = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFDictionary?.self)
    else {
      return false
    }

    return CFDictionaryContainsKey(
      first,
      Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque()
    )
  }
}

private final class StreamCommandRunner: NSObject, SCStreamOutput, SCStreamDelegate {
  private let fps: Int
  private let udid: String
  private let writer = PacketWriter()

  private let controlExecutor: SimulatorControlExecutor
  private let controlQueue = DispatchQueue(label: "codesymphony.simulator-bridge.control", qos: .userInitiated)
  private var directFramebufferCapture: DirectSimulatorFramebufferCapture?
  private var encoderCodec: IosSimulatorStreamCodec = .jpeg
  private let encoderQueue = DispatchQueue(label: "codesymphony.simulator-bridge.encode", qos: .userInteractive)
  private let frameStateLock = NSLock()
  private let metadataStateLock = NSLock()
  private var encoder: StreamVideoEncoder?
  private var encodeLoopRunning = false
  private var controlBuffer = Data()
  private var keyboardSyncState = KeyboardSyncState(available: false, visible: false)
  private var latestMetadata: StreamMetadata?
  private var latestFrame: PendingVideoFrame?
  private let sampleQueue = DispatchQueue(label: "codesymphony.simulator-bridge.capture", qos: .userInteractive)
  private var stream: SCStream?

  init(fps: Int, udid: String) {
    self.fps = fps
    self.udid = udid
    self.controlExecutor = SimulatorControlExecutor(udid: udid)
    super.init()
    self.controlExecutor.onKeyboardSyncStateChange = { [weak self] nextState in
      self?.updateKeyboardSyncState(nextState)
    }
  }

  @MainActor
  func start() async throws {
    let simulator = try SimulatorDiscovery.bootedSimulator(udid: udid)
    let screenSize = DeviceProfile.screenSize(for: simulator.deviceTypeIdentifier)
    let pointHeight = max(Int((screenSize?.height ?? 0).rounded()), 1)
    let pointWidth = max(Int((screenSize?.width ?? 0).rounded()), 1)

    installControlInputHandler()

    let preferredTargetSize = preferredFramebufferTargetPixelSize(screenSize: screenSize)
    switch getIosSimulatorCaptureModePreference() {
    case .framebuffer:
      if try await startDirectFramebufferCapture(
        deviceName: simulator.name,
        pointHeight: pointHeight,
        pointWidth: pointWidth,
        preferredTargetSize: preferredTargetSize
      ) {
        prewarmControlExecutor()
        return
      }
      try await startScreenCaptureKitStream(
        deviceName: simulator.name,
        pointHeight: pointHeight,
        pointWidth: pointWidth,
        simulator: simulator,
        screenSize: screenSize
      )
      prewarmControlExecutor()
    case .window:
      try await startScreenCaptureKitStream(
        deviceName: simulator.name,
        pointHeight: pointHeight,
        pointWidth: pointWidth,
        simulator: simulator,
        screenSize: screenSize
      )
      prewarmControlExecutor()
    }
  }

  @MainActor
  func stop() async {
    clearControlInputHandler()
    clearPendingFrames()
    directFramebufferCapture?.stop()
    directFramebufferCapture = nil

    if let stream {
      try? await stream.stopCapture()
      self.stream = nil
    }

    encoderQueue.sync {}
    encoder?.finish()
    encoder = nil
    controlExecutor.stop()
  }

  @MainActor
  private func startDirectFramebufferCapture(
    deviceName: String,
    pointHeight: Int,
    pointWidth: Int,
    preferredTargetSize: (height: Int, width: Int)?
  ) async throws -> Bool {
    let capture = DirectSimulatorFramebufferCapture()
    configureEncoder(
      captureMode: .framebuffer,
      deviceName: deviceName,
      pointHeight: pointHeight,
      pointWidth: pointWidth,
      preferredTargetSize: preferredTargetSize
    )

    do {
      try await capture.start(deviceUDID: udid) { [weak self] pixelBuffer, capturedAtMs in
        self?.enqueueFrame(
          pixelBuffer: pixelBuffer,
          capturedAtMs: capturedAtMs,
          changeRatio: nil
        )
      }
      directFramebufferCapture = capture
      let targetDescription = preferredTargetSize.map { "\($0.width)x\($0.height)" } ?? "native"
      StderrLogger.log(
        "SimulatorBridge streaming \(deviceName) (\(udid)) via direct framebuffer capture (codec: \(encoderCodecLabel()), target: \(targetDescription))."
      )
      return true
    } catch {
      encoder?.finish()
      encoder = nil
      directFramebufferCapture = nil
      StderrLogger.log("SimulatorBridge framebuffer capture unavailable for \(udid): \(error.localizedDescription)")
      return false
    }
  }

  @MainActor
  private func startScreenCaptureKitStream(
    deviceName _: String,
    pointHeight: Int,
    pointWidth: Int,
    simulator: BootedSimulator,
    screenSize: DeviceProfile.ScreenSize?
  ) async throws {
    configureEncoder(
      captureMode: .window,
      deviceName: simulator.name,
      pointHeight: pointHeight,
      pointWidth: pointWidth,
      preferredTargetSize: nil
    )
    let resolved = try await SimulatorDiscovery.resolve(udid: udid)
    let config = SCStreamConfiguration()
    config.sourceRect = resolved.captureRect
    config.width = resolved.pixelWidth
    config.height = resolved.pixelHeight
    config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    config.pixelFormat = kCVPixelFormatType_32BGRA
    config.queueDepth = 2
    config.showsCursor = false
    config.capturesAudio = false

    let captureStream = SCStream(
      filter: SCContentFilter(desktopIndependentWindow: resolved.window),
      configuration: config,
      delegate: self
    )

    try captureStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
    stream = captureStream
    try await captureStream.startCapture()

    let logicalWidth = max(Int((screenSize?.width ?? CGFloat(resolved.pixelWidth)).rounded()), 1)
    let logicalHeight = max(Int((screenSize?.height ?? CGFloat(resolved.pixelHeight)).rounded()), 1)
    StderrLogger.log(
      "SimulatorBridge streaming \(simulator.name) (\(udid)) via ScreenCaptureKit (codec: \(encoderCodecLabel())) at \(resolved.pixelWidth)x\(resolved.pixelHeight) (logical: \(logicalWidth)x\(logicalHeight))."
    )
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    StderrLogger.log("ScreenCaptureKit stopped: \(error.localizedDescription)")
    Task { @MainActor in
      await stop()
      exit(1)
    }
  }

  nonisolated func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
    guard outputType == .screen else {
      return
    }

    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
      return
    }

    enqueueFrame(
      pixelBuffer: pixelBuffer,
      capturedAtMs: currentUnixTimestampMs(),
      changeRatio: frameChangeRatio(
        sampleBuffer: sampleBuffer,
        pixelHeight: CVPixelBufferGetHeight(pixelBuffer),
        pixelWidth: CVPixelBufferGetWidth(pixelBuffer)
      )
    )
  }

  private func enqueueFrame(pixelBuffer: CVPixelBuffer, capturedAtMs: UInt64, changeRatio: Double?) {
    let shouldStartLoop: Bool

    frameStateLock.lock()
    latestFrame = PendingVideoFrame(
      capturedAtMs: capturedAtMs,
      changeRatio: changeRatio,
      pixelBuffer: pixelBuffer
    )
    shouldStartLoop = !encodeLoopRunning
    if shouldStartLoop {
      encodeLoopRunning = true
    }
    frameStateLock.unlock()

    guard shouldStartLoop else {
      return
    }

    encoderQueue.async { [weak self] in
      self?.runEncodeLoop()
    }
  }

  private func clearPendingFrames() {
    frameStateLock.lock()
    latestFrame = nil
    frameStateLock.unlock()
  }

  private func configureEncoder(
    captureMode: IosSimulatorCaptureModePreference,
    deviceName: String,
    pointHeight: Int,
    pointWidth: Int,
    preferredTargetSize: (height: Int, width: Int)?
  ) {
    encoder?.finish()
    encoderCodec = preferredIosSimulatorStreamCodec(for: captureMode)

    switch encoderCodec {
    case .jpeg:
      let nextEncoder = JpegEncoder(
        deviceName: deviceName,
        pointHeight: pointHeight,
        pointWidth: pointWidth,
        udid: udid,
        writer: writer,
        metadataStateProvider: { [weak self] in
          self?.currentKeyboardSyncState() ?? KeyboardSyncState(available: false, visible: false)
        },
        metadataObserver: { [weak self] metadata in
          self?.rememberLatestMetadata(metadata)
        }
      )
      nextEncoder.updateTargetPixelSize(
        height: preferredTargetSize?.height,
        width: preferredTargetSize?.width
      )
      encoder = nextEncoder
    case .h264:
      let nextEncoder = H264Encoder(
        deviceName: deviceName,
        fps: fps,
        pointHeight: pointHeight,
        pointWidth: pointWidth,
        udid: udid,
        writer: writer,
        metadataStateProvider: { [weak self] in
          self?.currentKeyboardSyncState() ?? KeyboardSyncState(available: false, visible: false)
        },
        metadataObserver: { [weak self] metadata in
          self?.rememberLatestMetadata(metadata)
        }
      )
      nextEncoder.updateTargetPixelSize(
        height: preferredTargetSize?.height,
        width: preferredTargetSize?.width
      )
      encoder = nextEncoder
    }
  }

  private func currentKeyboardSyncState() -> KeyboardSyncState {
    metadataStateLock.lock()
    defer { metadataStateLock.unlock() }
    return keyboardSyncState
  }

  private func rememberLatestMetadata(_ metadata: StreamMetadata) {
    metadataStateLock.lock()
    latestMetadata = metadata
    metadataStateLock.unlock()
  }

  private func updateKeyboardSyncState(_ nextState: KeyboardSyncState) {
    let metadataToSend: StreamMetadata?

    metadataStateLock.lock()
    keyboardSyncState = nextState
    if let latestMetadata {
      let updatedMetadata = StreamMetadata(
        codec: latestMetadata.codec,
        deviceName: latestMetadata.deviceName,
        keyboardSyncAvailable: nextState.available,
        pointHeight: latestMetadata.pointHeight,
        pointWidth: latestMetadata.pointWidth,
        pixelHeight: latestMetadata.pixelHeight,
        pixelWidth: latestMetadata.pixelWidth,
        softwareKeyboardVisible: nextState.visible,
        udid: latestMetadata.udid
      )
      metadataToSend = updatedMetadata == latestMetadata ? nil : updatedMetadata
      if let metadataToSend {
        self.latestMetadata = metadataToSend
      }
    } else {
      metadataToSend = nil
    }
    metadataStateLock.unlock()

    guard let metadataToSend else {
      return
    }

    do {
      try writer.sendJSON(metadataToSend)
    } catch {
      StderrLogger.log("SimulatorBridge metadata update failed: \(error.localizedDescription)")
    }
  }

  private func encoderCodecLabel() -> String {
    switch encoderCodec {
    case .h264:
      return "h264"
    case .jpeg:
      return "jpeg"
    }
  }

  private func prewarmControlExecutor() {
    controlQueue.async { [controlExecutor] in
      controlExecutor.prepareForStreaming()
    }
  }

  private func runEncodeLoop() {
    while true {
      let nextFrame: PendingVideoFrame?

      frameStateLock.lock()
      nextFrame = latestFrame
      latestFrame = nil
      if nextFrame == nil {
        encodeLoopRunning = false
      }
      frameStateLock.unlock()

      guard let nextFrame else {
        return
      }

      guard let encoder else {
        continue
      }

      do {
        try autoreleasepool {
          try encoder.encode(
            pixelBuffer: nextFrame.pixelBuffer,
            capturedAtMs: nextFrame.capturedAtMs,
            changeRatio: nextFrame.changeRatio
          )
        }
      } catch {
        StderrLogger.log(error.localizedDescription)
      }
    }
  }

  private func currentUnixTimestampMs() -> UInt64 {
    UInt64(Date().timeIntervalSince1970 * 1000)
  }

  private func frameChangeRatio(sampleBuffer: CMSampleBuffer, pixelHeight: Int, pixelWidth: Int) -> Double? {
    guard
      pixelWidth > 0,
      pixelHeight > 0,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
        as? [[SCStreamFrameInfo: Any]],
      let sampleAttachment = attachments.first,
      let dirtyRects = sampleAttachment[.dirtyRects] as? [NSValue]
    else {
      return nil
    }

    if dirtyRects.isEmpty {
      return 0
    }

    let frameRect = CGRect(x: 0, y: 0, width: pixelWidth, height: pixelHeight)
    let frameArea = Double(pixelWidth * pixelHeight)
    guard frameArea > 0 else {
      return nil
    }

    var dirtyArea = 0.0
    for dirtyRectValue in dirtyRects {
      let clippedRect = dirtyRectValue.rectValue.intersection(frameRect)
      if clippedRect.isNull || clippedRect.isEmpty {
        continue
      }
      dirtyArea += Double(clippedRect.width * clippedRect.height)
    }

    return min(max(dirtyArea / frameArea, 0), 1)
  }

  private func installControlInputHandler() {
    let inputHandle = FileHandle.standardInput
    inputHandle.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard let self else {
        handle.readabilityHandler = nil
        return
      }

      guard data.isEmpty == false else {
        handle.readabilityHandler = nil
        return
      }

      self.controlQueue.async {
        self.consumeControlInput(data)
      }
    }
  }

  private func clearControlInputHandler() {
    FileHandle.standardInput.readabilityHandler = nil
  }

  private func consumeControlInput(_ data: Data) {
    controlBuffer.append(data)

    while let newlineIndex = controlBuffer.firstIndex(of: 0x0A) {
      let line = controlBuffer.prefix(upTo: newlineIndex)
      controlBuffer.removeSubrange(...newlineIndex)
      handleControlLine(Data(line))
    }
  }

  private func handleControlLine(_ line: Data) {
    guard line.isEmpty == false else {
      return
    }

    do {
      let action = try ControlMessageParser.parse(line)
      try controlExecutor.perform(action)
    } catch {
      StderrLogger.log("SimulatorBridge control failed: \(error.localizedDescription)")
    }
  }
}

@main
struct SimulatorBridgeMain {
  static func main() {
    Task {
      do {
        switch try BridgeCommand.parse() {
        case .stream(let command):
          let runner = StreamCommandRunner(fps: command.fps, udid: command.udid)
          try await runner.start()

          let signalTrap = SignalTrap()
          signalTrap.install {
            Task { @MainActor in
              await runner.stop()
              exit(0)
            }
          }

          await MainActor.run {
            BridgeProcessState.shared.runner = runner
            BridgeProcessState.shared.signalTrap = signalTrap
          }
        case .status(let command):
          let runner = StatusCommandRunner(udid: command.udid)
          try await runner.run()
          exit(0)
        case .control(let command):
          let runner = ControlCommandRunner(command: command)
          try await runner.run()
          exit(0)
        }
      } catch {
        StderrLogger.log(error.localizedDescription)
        exit(1)
      }
    }

    dispatchMain()
  }
}
