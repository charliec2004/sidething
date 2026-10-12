import AppKit

// SideThing's own simple display-and-dial mark, drawn at each icon size.
let folder = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
for size in [16, 32, 64, 128, 256, 512, 1024] {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let scale = CGFloat(size) / 1024
    let affine = NSAffineTransform(); affine.scale(by: scale); affine.concat()
    NSColor(calibratedRed: 0.055, green: 0.062, blue: 0.075, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 40, y: 40, width: 944, height: 944), xRadius: 208, yRadius: 208).fill()
    NSColor(calibratedWhite: 0.94, alpha: 1).setStroke()
    let display = NSBezierPath(roundedRect: NSRect(x: 210, y: 304, width: 604, height: 416), xRadius: 62, yRadius: 62)
    display.lineWidth = 36; display.stroke()
    let dial = NSBezierPath(ovalIn: NSRect(x: 642, y: 520, width: 92, height: 92)); dial.lineWidth = 28; dial.stroke()
    NSColor(calibratedWhite: 0.94, alpha: 1).setFill()
    let play = NSBezierPath(); play.move(to: NSPoint(x: 365, y: 415)); play.line(to: NSPoint(x: 365, y: 603)); play.line(to: NSPoint(x: 518, y: 509)); play.close(); play.fill()
    NSGraphicsContext.restoreGraphicsState()
    let suffix = size == 1024 ? "icon_512x512@2x.png" : "icon_\(size)x\(size).png"
    try bitmap.representation(using: .png, properties: [:])!.write(to: folder.appendingPathComponent(suffix))
    if size == 32 || size == 64 || size == 256 || size == 512 {
        try bitmap.representation(using: .png, properties: [:])!.write(to: folder.appendingPathComponent("icon_\(size/2)x\(size/2)@2x.png"))
    }
}
