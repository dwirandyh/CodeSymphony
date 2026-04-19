// swift-tools-version: 5.10

import PackageDescription

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
    .executableTarget(
      name: "SimulatorBridge",
      path: "Sources"
    ),
  ]
)
