// swift-tools-version: 5.10

import Foundation
import PackageDescription

let axeFrameworksSearchPaths = [
  "/opt/homebrew/opt/axe/libexec/Frameworks",
  "/usr/local/opt/axe/libexec/Frameworks",
]

let axeFrameworksPath = axeFrameworksSearchPaths.first(where: { FileManager.default.fileExists(atPath: $0) })

let simulatorBridgeTargetSettings: [Target] = [
  .executableTarget(
    name: "SimulatorBridge",
    path: "Sources",
    swiftSettings: axeFrameworksPath.map {
      [
        .unsafeFlags(["-F", $0]),
      ]
    } ?? [],
    linkerSettings: axeFrameworksPath.map {
      [
        .unsafeFlags([
          "-F", $0,
          "-Xlinker", "-rpath",
          "-Xlinker", $0,
          "-framework", "FBSimulatorControl",
          "-framework", "FBControlCore",
          "-framework", "FBDeviceControl",
          "-framework", "XCTestBootstrap",
        ]),
      ]
    } ?? []
  ),
]

let package = Package(
  name: "SimulatorBridge",
  platforms: [
    .macOS(.v14),
  ],
  products: [
    .executable(
      name: "SimulatorBridge",
      targets: ["SimulatorBridge"]
    ),
  ],
  targets: [
    simulatorBridgeTargetSettings[0],
  ]
)
