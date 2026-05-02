export type IosViewportGeometry = {
  deviceHeight: number;
  deviceWidth: number;
  frameHeight: number;
  frameWidth: number;
};

export function buildIosViewportGeometryKey(args: IosViewportGeometry): string | null {
  const { deviceHeight, deviceWidth, frameHeight, frameWidth } = args;
  if (deviceHeight <= 0 || deviceWidth <= 0 || frameHeight <= 0 || frameWidth <= 0) {
    return null;
  }

  return `${frameWidth}x${frameHeight}:${deviceWidth}x${deviceHeight}`;
}

export function shouldRetainIosViewportAlignment(args: {
  aligned: boolean;
  hasFrame: boolean;
  lastAlignedGeometryKey: string;
  nextGeometryKey: string | null;
}): boolean {
  return !args.aligned
    && args.hasFrame
    && args.nextGeometryKey !== null
    && args.lastAlignedGeometryKey === args.nextGeometryKey;
}
