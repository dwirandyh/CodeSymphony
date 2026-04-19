import AppKit
import ApplicationServices
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

private enum ControlAction {
  case tap(x: Double, y: Double)
  case touch(x: Double, y: Double, phase: String)
  case swipe(startX: Double, startY: Double, endX: Double, endY: Double, duration: Double)
  case text(String)
  case key(String, duration: Double?)
  case button(String)
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
      SimulatorBridge control --udid <SIMULATOR_UDID> --action <tap|touch|swipe|text|key|button> [options]
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
      guard phase == "down" || phase == "up" else {
        throw BridgeError.invalidArguments("touch requires --phase <down|up>.")
      }
      action = .touch(x: x, y: y, phase: phase)
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
      action = .swipe(startX: startX, startY: startY, endX: endX, endY: endY, duration: duration)
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
    default:
      throw BridgeError.invalidArguments("Unsupported control action: \(actionName)")
    }

    return ControlCommand(udid: udid, action: action)
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
    let pixel_height: Int
    let pixel_width: Int
  }

  let session_info: SessionInfo
}

private struct StreamMetadata: Encodable {
  let codec: String
  let deviceName: String
  let pointHeight: Int
  let pointWidth: Int
  let pixelHeight: Int
  let pixelWidth: Int
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
}

private enum StderrLogger {
  static func log(_ message: String) {
    guard let data = "\(message)\n".data(using: .utf8) else {
      return
    }

    FileHandle.standardError.write(data)
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
      captureDisplay: captureDisplay,
      device: device,
      absoluteDisplayRect: absoluteDisplayRect,
      pixelHeight: max(Int(captureRect.height * backingScale), 1),
      pixelWidth: max(Int(captureRect.width * backingScale), 1),
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
      pixelHeight: max(Int(captureRect.height * backingScale), 1),
      pixelWidth: max(Int(captureRect.width * backingScale), 1),
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
    let pixelWidth = max(resolved?.pixelWidth ?? deviceWidth, 1)
    let pixelHeight = max(resolved?.pixelHeight ?? deviceHeight, 1)
    let payload = SimulatorStatusPayload(
      session_info: .init(
        device_height: deviceHeight,
        device_width: deviceWidth,
        pixel_height: pixelHeight,
        pixel_width: pixelWidth
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
      guard phase == "down" || phase == "up" else {
        throw BridgeError.invalidArguments("touch requires phase down or up.")
      }
      return .touch(
        x: try readNumber(payload, key: "x"),
        y: try readNumber(payload, key: "y"),
        phase: phase
      )
    case "swipe":
      return .swipe(
        startX: try readNumber(payload, key: "start_x"),
        startY: try readNumber(payload, key: "start_y"),
        endX: try readNumber(payload, key: "end_x"),
        endY: try readNumber(payload, key: "end_y"),
        duration: min(max(readOptionalNumber(payload, key: "duration") ?? 0.2, 0.08), 0.8)
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
}

private final class SimulatorControlExecutor {
  private let udid: String
  private let axeExecutableURL: URL
  #if canImport(FBControlCore) && canImport(FBSimulatorControl)
  private var nativeControlUnavailableReason: String?
  private var nativeSession: NativeSimulatorControlSession?
  #endif

  init(udid: String) {
    self.udid = udid
    self.axeExecutableURL = SimulatorControlExecutor.resolveAxeExecutableURL()
  }

  func prepareForStreaming() {
    #if canImport(FBControlCore) && canImport(FBSimulatorControl)
    guard nativeSession == nil, nativeControlUnavailableReason == nil else {
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
  }

  func stop() {
    #if canImport(FBControlCore) && canImport(FBSimulatorControl)
    nativeSession?.disconnect()
    nativeSession = nil
    #endif
  }

  func perform(_ action: ControlAction) throws {
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
    case .touch(let x, let y, let phase):
      try performTouch(x: x, y: y, phase: phase)
    case .swipe(let startX, let startY, let endX, let endY, let duration):
      try performSwipe(
        startX: startX,
        startY: startY,
        endX: endX,
        endY: endY,
        duration: duration
      )
    case .text(let text):
      try performText(text)
    case .key(let key, let duration):
      try performNamedKey(key, duration: duration)
    case .button(let button):
      try performButton(button)
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

  private func performTouch(x: Double, y: Double, phase: String) throws {
    var arguments = [
      "touch",
      "-x",
      coordinateString(x),
      "-y",
      coordinateString(y),
    ]
    if phase == "down" {
      arguments.append("--down")
    } else {
      arguments.append("--up")
    }
    arguments += [
      "--udid",
      udid,
    ]

    try runAxe(arguments: arguments)
  }

  private func performSwipe(
    startX: Double,
    startY: Double,
    endX: Double,
    endY: Double,
    duration: Double
  ) throws {
    try runAxe(arguments: [
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
      "--udid",
      udid,
    ])
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
}

#if canImport(FBControlCore) && canImport(FBSimulatorControl)
private final class NativeSimulatorControlSession {
  private let hid: FBSimulatorHID
  private let control: FBSimulatorControl
  private let simulator: FBSimulator
  private let udid: String

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
  }

  func canHandle(_ action: ControlAction) -> Bool {
    switch action {
    case .tap, .touch, .swipe, .key, .button:
      return true
    case .text:
      return false
    }
  }

  func perform(_ action: ControlAction) throws {
    switch action {
    case .tap(let x, let y):
      _ = try FBSimulatorHIDEvent.tapAt(x: x, y: y).perform(on: hid).await(withTimeout: 5)
    case .touch(let x, let y, let phase):
      let event = phase == "down"
        ? FBSimulatorHIDEvent.touchDownAt(x: x, y: y)
        : FBSimulatorHIDEvent.touchUpAt(x: x, y: y)
      _ = try event.perform(on: hid).await(withTimeout: 5)
    case .swipe(let startX, let startY, let endX, let endY, let duration):
      _ = try FBSimulatorHIDEvent.swipe(
        startX,
        yStart: startY,
        xEnd: endX,
        yEnd: endY,
        delta: DEFAULT_SWIPE_DELTA,
        duration: duration
      ).perform(on: hid).await(withTimeout: 5)
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
      _ = try hid.sendButtonEvent(with: .down, button: hidButton).await(withTimeout: 5)
      _ = try hid.sendButtonEvent(with: .up, button: hidButton).await(withTimeout: 5)
    }
  }

  func disconnect() {
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

private final class H264Encoder {
  private let writer: PacketWriter
  private let deviceName: String
  private let fps: Int
  private let pointHeight: Int
  private let pointWidth: Int
  private let udid: String

  private var compressionSession: VTCompressionSession?
  private var currentHeight = 0
  private var currentWidth = 0
  private var lastCodec = ""
  private var lastMetadataSignature = ""
  private var pendingForcedKeyFrame = true

  init(deviceName: String, fps: Int, pointHeight: Int, pointWidth: Int, udid: String, writer: PacketWriter) {
    self.deviceName = deviceName
    self.fps = fps
    self.pointHeight = pointHeight
    self.pointWidth = pointWidth
    self.udid = udid
    self.writer = writer
  }

  func encode(sampleBuffer: CMSampleBuffer) throws {
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
      return
    }

    try encode(
      pixelBuffer: pixelBuffer,
      presentationTimeStamp: CMSampleBufferGetPresentationTimeStamp(sampleBuffer),
      duration: CMSampleBufferGetDuration(sampleBuffer)
    )
  }

  func encode(pixelBuffer: CVPixelBuffer, presentationTimeStamp: CMTime, duration: CMTime) throws {
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
      sourceFrameRefcon: nil,
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
    pendingForcedKeyFrame = true

    let callback: VTCompressionOutputCallback = { outputRefCon, _, status, _, sampleBuffer in
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
        try encoder.handleEncoded(sampleBuffer: sampleBuffer)
      } catch {
        StderrLogger.log(error.localizedDescription)
      }
    }

    var newSession: VTCompressionSession?
    let status = VTCompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      width: Int32(width),
      height: Int32(height),
      codecType: kCMVideoCodecType_H264,
      encoderSpecification: nil,
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
    setCompressionProperty(newSession, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_AutoLevel)
    setCompressionProperty(newSession, key: kVTCompressionPropertyKey_MaxFrameDelayCount, value: 1 as CFTypeRef)
    setCompressionProperty(newSession, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: fps as CFTypeRef)
    setCompressionProperty(newSession, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: 1 as CFTypeRef)
    setCompressionProperty(newSession, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFTypeRef)

    let entropyMode = kVTH264EntropyMode_CABAC as CFTypeRef
    setCompressionProperty(newSession, key: kVTCompressionPropertyKey_H264EntropyMode, value: entropyMode)

    let averageBitrate = NSNumber(value: max(width * height * 6, 2_000_000))
    setCompressionProperty(newSession, key: kVTCompressionPropertyKey_AverageBitRate, value: averageBitrate)

    let dataRateLimits: [NSNumber] = [
      NSNumber(value: max(width * height * 8, 3_000_000)),
      1,
    ]
    setCompressionProperty(newSession, key: kVTCompressionPropertyKey_DataRateLimits, value: dataRateLimits as CFArray)

    VTCompressionSessionPrepareToEncodeFrames(newSession)
  }

  private func setCompressionProperty(_ session: VTCompressionSession, key: CFString, value: CFTypeRef) {
    let status = VTSessionSetProperty(session, key: key, value: value)
    guard status != noErr else {
      return
    }

    StderrLogger.log("VTSessionSetProperty \(key) failed with status \(status).")
  }

  private func handleEncoded(sampleBuffer: CMSampleBuffer) throws {
    guard CMSampleBufferDataIsReady(sampleBuffer),
          let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer) else {
      return
    }

    let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
    let keyFrame = !attachmentContainsNotSync(attachments)

    try maybeSendFormatDescription(formatDescription)
    let payload = try annexBPayload(from: sampleBuffer)
    try writer.send(type: keyFrame ? .keyFrame : .deltaFrame, payload: payload)
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
      try writer.sendJSON(StreamMetadata(
        codec: codec,
        deviceName: deviceName,
        pointHeight: pointHeight,
        pointWidth: pointWidth,
        pixelHeight: currentHeight,
        pixelWidth: currentWidth,
        udid: udid
      ))
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
  private let frameInterval: CMTime
  private let frameIntervalNanoseconds: UInt64

  private let controlExecutor: SimulatorControlExecutor
  private let controlQueue = DispatchQueue(label: "codesymphony.simulator-bridge.control", qos: .userInitiated)
  private var encoder: H264Encoder?
  private var controlBuffer = Data()
  private var framePump: DispatchSourceTimer?
  private var latestPixelBuffer: CVPixelBuffer?
  private var nextPresentationTime = CMTime.invalid
  private var sampleQueue = DispatchQueue(label: "codesymphony.simulator-bridge.capture", qos: .userInteractive)
  private var stream: SCStream?

  init(fps: Int, udid: String) {
    self.fps = fps
    self.udid = udid
    self.frameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    self.frameIntervalNanoseconds = max(UInt64(1_000_000_000 / max(fps, 1)), 1)
    self.controlExecutor = SimulatorControlExecutor(udid: udid)
  }

  @MainActor
  func start() async throws {
    let resolved = try await SimulatorDiscovery.resolve(udid: udid)
    let screenSize = DeviceProfile.screenSize(for: resolved.device.deviceTypeIdentifier)
    let captureRect = WindowDisplayResolver.captureRect(for: resolved.window)

    let config = SCStreamConfiguration()
    config.sourceRect = captureRect
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
    try await captureStream.startCapture()

    encoder = H264Encoder(
      deviceName: resolved.device.name,
      fps: fps,
      pointHeight: max(Int((screenSize?.height ?? CGFloat(resolved.pixelHeight)).rounded()), 1),
      pointWidth: max(Int((screenSize?.width ?? CGFloat(resolved.pixelWidth)).rounded()), 1),
      udid: udid,
      writer: writer
    )
    controlExecutor.prepareForStreaming()
    startFramePump()
    stream = captureStream
    installControlInputHandler()

    StderrLogger.log("SimulatorBridge streaming \(resolved.device.name) (\(udid)).")
  }

  @MainActor
  func stop() async {
    clearControlInputHandler()
    stopFramePump()
    encoder?.finish()
    encoder = nil
    controlExecutor.stop()

    if let stream {
      try? await stream.stopCapture()
      self.stream = nil
    }
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

    latestPixelBuffer = pixelBuffer
  }

  private func startFramePump() {
    stopFramePump()

    let timer = DispatchSource.makeTimerSource(queue: sampleQueue)
    timer.schedule(
      deadline: .now(),
      repeating: .nanoseconds(Int(frameIntervalNanoseconds)),
      leeway: .nanoseconds(Int(max(frameIntervalNanoseconds / 8, 1)))
    )
    timer.setEventHandler { [weak self] in
      self?.encodeLatestFrame()
    }
    framePump = timer
    timer.resume()
  }

  private func stopFramePump() {
    framePump?.setEventHandler {}
    framePump?.cancel()
    framePump = nil
    latestPixelBuffer = nil
    nextPresentationTime = .invalid
  }

  private func encodeLatestFrame() {
    guard let encoder, let latestPixelBuffer else {
      return
    }

    if !nextPresentationTime.isValid {
      nextPresentationTime = .zero
    }

    do {
      try encoder.encode(
        pixelBuffer: latestPixelBuffer,
        presentationTimeStamp: nextPresentationTime,
        duration: frameInterval
      )
      nextPresentationTime = CMTimeAdd(nextPresentationTime, frameInterval)
    } catch {
      StderrLogger.log(error.localizedDescription)
    }
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
