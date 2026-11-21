import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Usage: swift icons.swift <outdir>
let out = URL(fileURLWithPath: CommandLine.arguments[1])
let cs = CGColorSpace(name: CGColorSpace.sRGB)!

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
  CGColor(colorSpace: cs, components: [
    CGFloat((hex >> 16) & 0xff) / 255, CGFloat((hex >> 8) & 0xff) / 255, CGFloat(hex & 0xff) / 255, a,
  ])!
}

func makeContext(_ size: Int) -> CGContext {
  let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                      space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.setShouldAntialias(true)
  ctx.interpolationQuality = .high
  return ctx
}

func save(_ ctx: CGContext, _ name: String) {
  let url = out.appendingPathComponent(name)
  let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
  CGImageDestinationFinalize(dest)
}

struct Palette {
  var dough: CGColor, rim: CGColor, chip: CGColor, sparkle: CGColor
}
let warm = Palette(dough: rgb(0xE8B06A), rim: rgb(0xB0712F), chip: rgb(0x5A3215), sparkle: rgb(0xFFFFFF))
let mono = Palette(dough: rgb(0xD9D9D9), rim: rgb(0x9A9A9A), chip: rgb(0x3A3A3A), sparkle: rgb(0xFFFFFF))

// Cookie with a bite out of the upper right, drawn into its own transparent
// layer so the bite can be erased without touching any background.
// Coordinates are in a unit square (0...1, y up), scaled to `size`.
func cookieLayer(_ size: Int, _ p: Palette, sparkle: Bool) -> CGImage {
  let s = CGFloat(size)
  let ctx = makeContext(size)
  ctx.scaleBy(x: s, y: s)
  let c = CGPoint(x: 0.5, y: 0.5), r: CGFloat = 0.46
  let rimWidth: CGFloat = size <= 16 ? 0.07 : 0.045

  ctx.setFillColor(p.rim)
  ctx.fillEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
  let ri = r - rimWidth
  ctx.setFillColor(p.dough)
  ctx.fillEllipse(in: CGRect(x: c.x - ri, y: c.y - ri, width: 2 * ri, height: 2 * ri))

  // Fewer, bigger chips at tiny sizes so they don't turn to mush.
  let chips: [(CGFloat, CGFloat, CGFloat)] = size <= 32
    ? [(0.32, 0.60, 0.075), (0.55, 0.40, 0.07), (0.34, 0.33, 0.06), (0.70, 0.30, 0.055)]
    : [(0.30, 0.62, 0.060), (0.50, 0.50, 0.045), (0.36, 0.36, 0.050), (0.58, 0.30, 0.055),
       (0.74, 0.44, 0.045), (0.22, 0.46, 0.035), (0.48, 0.74, 0.040)]
  ctx.setFillColor(p.chip)
  for (x, y, cr) in chips {
    ctx.fillEllipse(in: CGRect(x: x - cr, y: y - cr, width: 2 * cr, height: 2 * cr))
  }

  // Bite: three overlapping circles erased from the upper-right edge.
  ctx.setBlendMode(.clear)
  for (x, y, br) in [(0.86, 0.80, 0.16), (0.96, 0.62, 0.12), (0.70, 0.96, 0.12)] as [(CGFloat, CGFloat, CGFloat)] {
    ctx.fillEllipse(in: CGRect(x: x - br, y: y - br, width: 2 * br, height: 2 * br))
  }
  ctx.setBlendMode(.normal)

  if sparkle {
    // Four-point "clean" sparkle sitting in the bite.
    let sc = CGPoint(x: 0.84, y: 0.84), big: CGFloat = 0.11, waist: CGFloat = 0.025
    let path = CGMutablePath()
    path.move(to: CGPoint(x: sc.x, y: sc.y + big))
    path.addLine(to: CGPoint(x: sc.x + waist, y: sc.y + waist))
    path.addLine(to: CGPoint(x: sc.x + big, y: sc.y))
    path.addLine(to: CGPoint(x: sc.x + waist, y: sc.y - waist))
    path.addLine(to: CGPoint(x: sc.x, y: sc.y - big))
    path.addLine(to: CGPoint(x: sc.x - waist, y: sc.y - waist))
    path.addLine(to: CGPoint(x: sc.x - big, y: sc.y))
    path.addLine(to: CGPoint(x: sc.x - waist, y: sc.y + waist))
    path.closeSubpath()
    ctx.setFillColor(p.sparkle)
    ctx.addPath(path)
    ctx.fillPath()
  }
  return ctx.makeImage()!
}

func gradientBackground(_ ctx: CGContext, _ rect: CGRect, top: CGColor, bottom: CGColor) {
  let g = CGGradient(colorsSpace: cs, colors: [top, bottom] as CFArray, locations: [0, 1])!
  ctx.drawLinearGradient(g, start: CGPoint(x: rect.midX, y: rect.maxY), end: CGPoint(x: rect.midX, y: rect.minY), options: [])
}

// Toolbar / extension icons: just the cookie, filling the canvas.
for size in [16, 32, 48, 128] {
  let ctx = makeContext(size)
  ctx.draw(cookieLayer(size, warm, sparkle: false), in: CGRect(x: 0, y: 0, width: size, height: size))
  save(ctx, "icon\(size).png")
}

// macOS app icon: rounded square inset per Apple's grid (824/1024 body,
// ~185 corner radius) with a soft shadow, cookie + sparkle on teal.
func macIcon(_ size: Int) -> CGContext {
  let s = CGFloat(size)
  let ctx = makeContext(size)
  let body = CGRect(x: s * 100 / 1024, y: s * 100 / 1024, width: s * 824 / 1024, height: s * 824 / 1024)
  let radius = s * 185 / 1024
  let shape = CGPath(roundedRect: body, cornerWidth: radius, cornerHeight: radius, transform: nil)
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -s * 10 / 1024), blur: s * 20 / 1024, color: rgb(0x000000, 0.3))
  ctx.addPath(shape)
  ctx.setFillColor(rgb(0x1F8A86))
  ctx.fillPath()
  ctx.restoreGState()
  ctx.saveGState()
  ctx.addPath(shape)
  ctx.clip()
  gradientBackground(ctx, body, top: rgb(0x4FD1C0), bottom: rgb(0x16797A))
  ctx.restoreGState()
  let cookieSize = body.width * 0.74
  let cookieRect = CGRect(x: body.midX - cookieSize / 2, y: body.midY - cookieSize / 2, width: cookieSize, height: cookieSize)
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -s * 8 / 1024), blur: s * 16 / 1024, color: rgb(0x000000, 0.25))
  ctx.draw(cookieLayer(Int(cookieSize.rounded()), warm, sparkle: size >= 64), in: cookieRect)
  ctx.restoreGState()
  return ctx
}

for size in [16, 32, 64, 128, 256, 512] {
  save(macIcon(size), "AppIcon-\(size).png")
}
save(macIcon(1024), "AppIcon-1024-mac.png")
save(macIcon(384), "Icon.png")

// iOS icons are full-bleed squares; the system applies the mask.
func iosIcon(background: (CGContext, CGRect) -> Void, palette: Palette) -> CGContext {
  let size = 1024
  let ctx = makeContext(size)
  let rect = CGRect(x: 0, y: 0, width: size, height: size)
  background(ctx, rect)
  let cookieSize: CGFloat = 700
  let cookieRect = CGRect(x: rect.midX - cookieSize / 2, y: rect.midY - cookieSize / 2, width: cookieSize, height: cookieSize)
  ctx.draw(cookieLayer(Int(cookieSize), palette, sparkle: true), in: cookieRect)
  return ctx
}
save(iosIcon(background: { ctx, r in gradientBackground(ctx, r, top: rgb(0x4FD1C0), bottom: rgb(0x16797A)) }, palette: warm),
     "AppIcon-1024-ios.png")
// Dark appearance: Apple wants a transparent background so the system's
// dark backdrop shows through.
save(iosIcon(background: { _, _ in }, palette: warm), "AppIcon-1024-ios-dark.png")
// Tinted appearance: grayscale artwork on black; the system applies the tint.
save(iosIcon(background: { ctx, r in ctx.setFillColor(rgb(0x000000)); ctx.fill(r) }, palette: mono),
     "AppIcon-1024-ios-tinted.png")
