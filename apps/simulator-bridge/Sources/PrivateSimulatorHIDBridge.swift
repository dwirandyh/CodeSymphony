import Foundation
import ObjectiveC
import Darwin

private func createPrivateHIDError(_ message: String) -> NSError {
  NSError(domain: "PrivateSimulatorHIDBridge", code: 1, userInfo: [
    NSLocalizedDescriptionKey: message,
  ])
}

final class PrivateSimulatorHIDBridge {
  private let hidClient: NSObject
  private let sendSelector: Selector

  private typealias IndigoMouseFunc = @convention(c) (
    UnsafePointer<CGPoint>, UnsafePointer<CGPoint>?, UInt32, Int32, CGFloat, CGFloat, UInt32
  ) -> UnsafeMutableRawPointer?
  private typealias IndigoButtonFunc = @convention(c) (Int32, Int32, Int32) -> UnsafeMutableRawPointer?

  private let mouseFunc: IndigoMouseFunc
  private let buttonFunc: IndigoButtonFunc?

  static let edgeNone: UInt32 = 0
  static let edgeLeft: UInt32 = 1
  static let edgeTop: UInt32 = 2
  static let edgeBottom: UInt32 = 3
  static let edgeRight: UInt32 = 4

  private static let buttonSourceHome: Int32 = 0x0
  private static let buttonDown: Int32 = 1
  private static let buttonUp: Int32 = 2
  private static let buttonTargetHardware: Int32 = 0x33

  init(device: NSObject) throws {
    _ = dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)
    _ = dlopen("/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit", RTLD_NOW)

    guard let mousePointer = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "IndigoHIDMessageForMouseNSEvent") else {
      throw createPrivateHIDError("Indigo touch injection is unavailable.")
    }
    self.mouseFunc = unsafeBitCast(mousePointer, to: IndigoMouseFunc.self)
    if let buttonPointer = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "IndigoHIDMessageForButton") {
      self.buttonFunc = unsafeBitCast(buttonPointer, to: IndigoButtonFunc.self)
    } else {
      self.buttonFunc = nil
    }

    guard let hidClass = NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient") else {
      throw createPrivateHIDError("Simulator HID client is unavailable.")
    }

    let initSelector = NSSelectorFromString("initWithDevice:error:")
    typealias HIDInitFunc = @convention(c) (AnyObject, Selector, AnyObject, AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?
    guard let initIMP = class_getMethodImplementation(hidClass, initSelector) else {
      throw createPrivateHIDError("Simulator HID client init is unavailable.")
    }

    let initFunc = unsafeBitCast(initIMP, to: HIDInitFunc.self)
    var error: NSError?
    guard let client = initFunc(hidClass.alloc(), initSelector, device, &error) as? NSObject else {
      throw error ?? createPrivateHIDError("Unable to create the simulator HID client.")
    }

    self.hidClient = client
    self.sendSelector = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
  }

  func sendTouch(phase: String, x: Double, y: Double, edge: UInt32) throws {
    let eventType: Int32
    switch phase {
    case "down", "move":
      eventType = 1
    case "up":
      eventType = 2
    default:
      throw createPrivateHIDError("Unsupported simulator touch phase: \(phase)")
    }

    var point = CGPoint(x: x, y: y)
    guard let message = mouseFunc(&point, nil, 0x32, eventType, 1.0, 1.0, edge) else {
      throw createPrivateHIDError("Unable to create the simulator touch message.")
    }

    typealias SendFunc = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, ObjCBool, AnyObject?, AnyObject?) -> Void
    guard let sendIMP = class_getMethodImplementation(object_getClass(hidClient), sendSelector) else {
      free(message)
      throw createPrivateHIDError("Unable to send the simulator touch message.")
    }

    let sendFunc = unsafeBitCast(sendIMP, to: SendFunc.self)
    sendFunc(hidClient, sendSelector, message, ObjCBool(true), nil, nil)
  }

  func sendSwipeHome() throws {
    let xPos = 0.5
    let yStart = 0.95
    let yEnd = 0.35
    let steps = 10
    let stepDelay: TimeInterval = 0.016

    try sendTouch(phase: "down", x: xPos, y: yStart, edge: Self.edgeBottom)
    Thread.sleep(forTimeInterval: stepDelay)

    for index in 1...steps {
      let progress = Double(index) / Double(steps)
      let y = yStart + (yEnd - yStart) * progress
      try sendTouch(phase: "move", x: xPos, y: y, edge: Self.edgeBottom)
      Thread.sleep(forTimeInterval: stepDelay)
    }

    try sendTouch(phase: "up", x: xPos, y: yEnd, edge: Self.edgeBottom)
  }

  func sendAppSwitcher() throws {
    guard buttonFunc != nil else {
      throw createPrivateHIDError("Simulator app switcher injection is unavailable.")
    }

    try sendHIDButton(eventSource: Self.buttonSourceHome, direction: Self.buttonDown)
    try sendHIDButton(eventSource: Self.buttonSourceHome, direction: Self.buttonUp)
    Thread.sleep(forTimeInterval: 0.15)
    try sendHIDButton(eventSource: Self.buttonSourceHome, direction: Self.buttonDown)
    try sendHIDButton(eventSource: Self.buttonSourceHome, direction: Self.buttonUp)
  }

  static func edgeValue(for name: String?) -> UInt32 {
    guard let normalized = name?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), normalized.isEmpty == false else {
      return edgeNone
    }

    switch normalized {
    case "bottom":
      return edgeBottom
    case "top":
      return edgeTop
    case "left":
      return edgeLeft
    case "right":
      return edgeRight
    default:
      return edgeNone
    }
  }

  private func sendHIDButton(eventSource: Int32, direction: Int32) throws {
    guard let buttonFunc else {
      throw createPrivateHIDError("Simulator button injection is unavailable.")
    }

    guard let message = buttonFunc(eventSource, direction, Self.buttonTargetHardware) else {
      throw createPrivateHIDError("Unable to create the simulator button message.")
    }

    typealias SendFunc = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, ObjCBool, AnyObject?, AnyObject?) -> Void
    guard let sendIMP = class_getMethodImplementation(object_getClass(hidClient), sendSelector) else {
      free(message)
      throw createPrivateHIDError("Unable to send the simulator button message.")
    }

    let sendFunc = unsafeBitCast(sendIMP, to: SendFunc.self)
    sendFunc(hidClient, sendSelector, message, ObjCBool(true), nil, nil)
  }
}
