import PapertownCore
import SwiftUI
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

// The research loop (研究回路) drawn the way the web draws it (web/src/progress/Canvas.tsx): the parts of the research
// flow as framed blocks in four rows, the stages, gates, checks, tasks, notes and info cards in them, and the lines
// between. Coordinates are the web's pixels at 100%, from GET /api/lines/{id}/canvas.

// MARK: - Geometry

enum LoopGeo {
    /// A block's frame pads its slot: this much on each side, its header above (canvas.py PAD, HEAD).
    static let pad: CGFloat = 28
    static let head: CGFloat = 64
    static let maxZoom: CGFloat = 1.8

    /// A node's size: the info cards carry theirs, every other kind has one (canvas.py, LoopCard.tsx).
    static func size(_ n: LoopNode) -> CGSize { size(kind: n.kind, w: n.w, h: n.h) }

    static func size(kind: String, w: Double? = nil, h: Double? = nil) -> CGSize {
        if let w, let h { return CGSize(width: w, height: h) }
        switch kind {
        case "stage": return CGSize(width: 230, height: 92)
        case "gate": return CGSize(width: 250, height: 96)
        case "hard": return CGSize(width: 210, height: 76)
        case "soft": return CGSize(width: 290, height: 96)
        case "spec", "clamp": return CGSize(width: 270, height: 92)
        case "human": return CGSize(width: 300, height: 104)
        case "task": return CGSize(width: 290, height: 108)
        case "note": return CGSize(width: 200, height: 80)
        default: return CGSize(width: 250, height: 190)
        }
    }

    static func frame(_ b: LoopBlock) -> CGRect {
        CGRect(x: b.x - pad, y: b.y - head, width: b.w + pad * 2, height: b.h + head + pad)
    }

    /// Everything on the loop, with a margin: what fitting shows.
    static func bounds(_ v: LoopView) -> CGRect {
        var r = CGRect.null
        for b in v.blocks ?? [] { r = r.union(frame(b)) }
        for n in v.nodes { r = r.union(CGRect(origin: CGPoint(x: n.x, y: n.y), size: size(n))) }
        if r.isNull { r = CGRect(x: 0, y: 0, width: 1200, height: 700) }
        return r.insetBy(dx: -36, dy: -30)
    }
}

/// Where the canvas sits on screen: a canvas point p lands at p × zoom + pan.
struct LoopCamera: Equatable {
    var zoom: CGFloat = 1
    var pan: CGPoint = .zero

    func screen(_ r: CGRect) -> CGRect {
        CGRect(x: r.minX * zoom + pan.x, y: r.minY * zoom + pan.y, width: r.width * zoom, height: r.height * zoom)
    }

    func canvas(_ p: CGPoint) -> CGPoint {
        CGPoint(x: (p.x - pan.x) / zoom, y: (p.y - pan.y) / zoom)
    }

    var transform: CGAffineTransform { CGAffineTransform(a: zoom, b: 0, c: 0, d: zoom, tx: pan.x, ty: pan.y) }

    /// `r` filling the view, short of `pad` on each side, at most `most`.
    static func fit(_ r: CGRect, in size: CGSize, pad: CGFloat = 0.03, most: CGFloat = 1.25) -> LoopCamera {
        guard size.width > 1, size.height > 1, r.width > 0, r.height > 0 else { return LoopCamera() }
        let z = min(size.width * (1 - pad * 2) / r.width, size.height * (1 - pad * 2) / r.height, most)
        return LoopCamera(zoom: z, pan: CGPoint(x: size.width / 2 - r.midX * z, y: size.height / 2 - r.midY * z))
    }

    /// At `zoom`, the canvas point under `anchor` staying put.
    func zoomed(to zoom: CGFloat, at anchor: CGPoint) -> LoopCamera {
        let c = canvas(anchor)
        return LoopCamera(zoom: zoom, pan: CGPoint(x: anchor.x - c.x * zoom, y: anchor.y - c.y * zoom))
    }

    /// The middle of the view kept over the loop, give or take a third of it.
    func kept(over r: CGRect, size: CGSize) -> LoopCamera {
        let room = r.insetBy(dx: -r.width * 0.35, dy: -r.height * 0.35)
        var c = canvas(CGPoint(x: size.width / 2, y: size.height / 2))
        c.x = min(max(c.x, room.minX), room.maxX)
        c.y = min(max(c.y, room.minY), room.maxY)
        return LoopCamera(zoom: zoom, pan: CGPoint(x: size.width / 2 - c.x * zoom, y: size.height / 2 - c.y * zoom))
    }
}

/// How much a node shows at a zoom: everything, all but the small print, or its name and one figure.
enum LoopDetail {
    case near, mid, far
    static func at(_ zoom: CGFloat) -> LoopDetail { zoom >= 0.7 ? .near : zoom >= 0.45 ? .mid : .far }
}

enum LoopFilter: String, CaseIterable, Identifiable {
    case all, needs, hard, soft
    var id: String { rawValue }
}

// MARK: - Colour

/// The canvas's colours, light and dark (web/src/progress/canvas.css, macos.css).
enum LoopInk {
    static let hard = dynamic(0xF73631, 0xF73F3A)
    static let pass = dynamic(0x0D9488, 0x2DD4BF)
    static let amber = dynamic(0xF78F01, 0xF79709)
    static let spec = dynamic(0x7C3AED, 0xA78BFA)
    static let clamp = dynamic(0x1E293B, 0xCBD5E1)
    static let brand = dynamic(0x007AFF, 0x0A84FF)
    static let ok = dynamic(0x28CD41, 0x32D74B)
    static let panel = dynamic(0xFFFFFF, 0x2A2A2D)
    static let ground = dynamic(0xF5F5F7, 0x1C1C1E)
    static let muted = Color.primary.opacity(0.5)
    static let line = Color.primary.opacity(0.12)

    /// A part of the flow's hue; the overview and the staff are neutral.
    static func block(_ key: String) -> Color {
        switch key {
        case "survey": return dynamic(0x7C3AED, 0xA78BFA)
        case "code": return dynamic(0x4F46E5, 0x818CF8)
        case "exp": return dynamic(0x2563EB, 0x60A5FA)
        case "data": return dynamic(0x0284C7, 0x38BDF8)
        case "paper": return dynamic(0xC026D3, 0xE879F9)
        default: return Color.gray
        }
    }

    static func symbol(_ key: String) -> String {
        switch key {
        case "overview": return "safari"
        case "survey": return "magnifyingglass"
        case "code": return "chevron.left.forwardslash.chevron.right"
        case "exp": return "flask"
        case "data": return "tablecells"
        case "paper": return "doc.text"
        case "agents": return "person.2"
        default: return "square.dashed"
        }
    }

    /// pass, warn, fail or block, run, and the rest.
    static func tone(_ t: String?) -> Color {
        switch t {
        case "pass", "done", "ok": return pass
        case "warn", "risk", "queued": return amber
        case "fail", "block", "blocked", "bad": return hard
        case "run", "sent", "running": return brand
        default: return muted
        }
    }

    static func dynamic(_ light: UInt32, _ dark: UInt32) -> Color {
        #if os(iOS)
        return Color(UIColor { $0.userInterfaceStyle == .dark ? ui(dark) : ui(light) })
        #elseif os(macOS)
        return Color(NSColor(name: nil) { a in
            a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? ns(dark) : ns(light)
        })
        #endif
    }

    private static func parts(_ v: UInt32) -> (CGFloat, CGFloat, CGFloat) {
        (CGFloat((v >> 16) & 0xFF) / 255, CGFloat((v >> 8) & 0xFF) / 255, CGFloat(v & 0xFF) / 255)
    }
    #if os(iOS)
    private static func ui(_ v: UInt32) -> UIColor { let c = parts(v); return UIColor(red: c.0, green: c.1, blue: c.2, alpha: 1) }
    #elseif os(macOS)
    private static func ns(_ v: UInt32) -> NSColor { let c = parts(v); return NSColor(red: c.0, green: c.1, blue: c.2, alpha: 1) }
    #endif
}

// MARK: - The board

/// The loop drawn at `camera`. Live, it pans with a drag, zooms with a pinch (or a double tap, or ⌘ and the scroll
/// wheel on a Mac), opens a node on a tap and moves one on a long press and drag; tapping a block's name zooms to it.
/// Otherwise it is a still picture.
struct LoopBoard: View {
    let ctx: LoopContext
    let size: CGSize
    @Binding var camera: LoopCamera
    var live = true
    var filter: LoopFilter = .all
    var allLines = false
    var selected: String? = nil
    /// The user panned or zoomed: the view stops refitting itself.
    var touched: () -> Void = {}
    var tap: (LoopNode) -> Void = { _ in }
    var moved: (String, CGPoint) -> Void = { _, _ in }

    @State private var placed: [String: CGPoint] = [:]
    @State private var lifting: String?
    @State private var lift: CGSize = .zero
    @State private var panFrom: CGPoint?
    @State private var pinchFrom: LoopCamera?

    private var bounds: CGRect { LoopGeo.bounds(ctx.view) }
    private var minZoom: CGFloat { min(1, LoopCamera.fit(bounds, in: size).zoom) * 0.98 }

    var body: some View {
        let cam = camera
        let rects = frames()
        let detail = LoopDetail.at(cam.zoom)
        let view = CGRect(origin: .zero, size: size).insetBy(dx: -60, dy: -60)
        ZStack(alignment: .topLeading) {
            LoopLines(ctx: ctx, camera: cam, rects: rects, filter: filter, allLines: allLines, selected: selected ?? lifting)
            ForEach(ctx.view.nodes) { n in
                if let r = rects[n.id], cam.screen(r).intersects(view) {
                    node(n, r, detail, cam)
                }
            }
            ForEach(ctx.view.blocks ?? []) { b in
                LoopBlockHead(block: b, ctx: ctx, camera: cam, live: live) { focus(b, rects) }
                    .zIndex(3)
            }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .contentShape(Rectangle())
        .clipped()
        .coordinateSpace(name: "loop")
        .modifier(BoardGestures(live: live, pan: panGesture, pinch: pinch, double: doubleTap, wheel: wheel))
        .onChange(of: positions) { _ in placed = [:] }
    }

    /// Every node's frame: where the server has it, where it was dropped since, or under the finger.
    private func frames() -> [String: CGRect] {
        var out: [String: CGRect] = [:]
        for n in ctx.view.nodes {
            var o = placed[n.id] ?? CGPoint(x: n.x, y: n.y)
            if lifting == n.id { o.x += lift.width / camera.zoom; o.y += lift.height / camera.zoom }
            out[n.id] = CGRect(origin: o, size: LoopGeo.size(n))
        }
        return out
    }

    /// Where the server has the nodes: a new answer replaces what was dropped in the meantime.
    private var positions: [String] { ctx.view.nodes.map { "\($0.id)@\(Int($0.x)),\(Int($0.y))" } }

    @ViewBuilder
    private func node(_ n: LoopNode, _ r: CGRect, _ detail: LoopDetail, _ cam: LoopCamera) -> some View {
        let s = cam.screen(r)
        let dim = !LoopRead.shown(n, filter)
        let card = LoopNodeView(node: n, ctx: ctx, detail: detail, zoom: cam.zoom, selected: selected == n.id || lifting == n.id)
            .frame(width: r.width, height: r.height)
            .contentShape(Rectangle())
        Group {
            if live {
                card
                    .onTapGesture { tap(n) }
                    .gesture(moveGesture(n, r))
            } else {
                card
            }
        }
        .scaleEffect(cam.zoom)
        .position(x: s.midX, y: s.midY)
        .opacity(dim ? 0.22 : 1)
        .shadow(color: .black.opacity(lifting == n.id ? 0.25 : 0), radius: 12, y: 6)
        .zIndex(lifting == n.id ? 2 : 1)
    }

    // MARK: Gestures

    private func moveGesture(_ n: LoopNode, _ r: CGRect) -> some Gesture {
        LongPressGesture(minimumDuration: 0.3)
            .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .named("loop")))
            .onChanged { value in
                guard case .second(true, let drag) = value else { return }
                if lifting != n.id {
                    lifting = n.id
                    lift = .zero
                    #if os(iOS)
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    #endif
                }
                lift = drag?.translation ?? .zero
            }
            .onEnded { value in
                defer { lifting = nil; lift = .zero }
                guard case .second(true, let drag) = value, let t = drag?.translation, abs(t.width) + abs(t.height) > 2 else { return }
                let start: CGPoint = placed[n.id] ?? CGPoint(x: n.x, y: n.y)
                let z: CGFloat = camera.zoom
                let x: CGFloat = start.x + t.width / z
                let y: CGFloat = start.y + t.height / z
                let to = CGPoint(x: x.rounded(), y: y.rounded())
                placed[n.id] = to
                moved(n.id, to)
            }
    }

    private var panGesture: some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { v in
                guard pinchFrom == nil else { return }
                if panFrom == nil { panFrom = camera.pan; touched() }
                let from = panFrom ?? camera.pan
                camera = LoopCamera(zoom: camera.zoom, pan: CGPoint(x: from.x + v.translation.width, y: from.y + v.translation.height))
                    .kept(over: bounds, size: size)
            }
            .onEnded { _ in panFrom = nil }
    }

    private func pinch(_ scale: CGFloat, _ anchor: CGPoint?, _ ended: Bool) {
        if ended { pinchFrom = nil; panFrom = nil; return }
        if pinchFrom == nil { pinchFrom = camera; touched() }
        guard let from = pinchFrom else { return }
        let z = min(max(from.zoom * scale, minZoom), LoopGeo.maxZoom)
        camera = from.zoomed(to: z, at: anchor ?? CGPoint(x: size.width / 2, y: size.height / 2)).kept(over: bounds, size: size)
    }

    private func doubleTap(_ at: CGPoint) {
        touched()
        let fit = LoopCamera.fit(bounds, in: size)
        let next: LoopCamera
        if camera.zoom >= LoopGeo.maxZoom * 0.95 {
            next = fit
        } else {
            next = camera.zoomed(to: min(camera.zoom * 2, LoopGeo.maxZoom), at: at).kept(over: bounds, size: size)
        }
        withAnimation(.easeInOut(duration: 0.3)) { camera = next }
    }

    private func wheel(_ dx: CGFloat, _ dy: CGFloat, _ zoom: Bool, _ at: CGPoint) {
        touched()
        if zoom {
            let z = min(max(camera.zoom * (1 - dy * 0.01), minZoom), LoopGeo.maxZoom)
            camera = camera.zoomed(to: z, at: at).kept(over: bounds, size: size)
        } else {
            camera = LoopCamera(zoom: camera.zoom, pan: CGPoint(x: camera.pan.x + dx, y: camera.pan.y + dy)).kept(over: bounds, size: size)
        }
    }

    /// Zooms to what a block holds, its name included.
    private func focus(_ b: LoopBlock, _ rects: [String: CGRect]) {
        guard live else { return }
        touched()
        let f = LoopGeo.frame(b)
        var r = CGRect(x: f.minX, y: f.minY, width: min(f.width, 420), height: LoopGeo.head)
        for n in ctx.view.nodes where n.mod == b.key { if let x = rects[n.id] { r = r.union(x) } }
        r = r.insetBy(dx: -24, dy: -16)
        withAnimation(.easeInOut(duration: 0.35)) {
            camera = LoopCamera.fit(r, in: size, pad: 0.04, most: LoopGeo.maxZoom)
        }
    }
}

/// Pan, pinch, double tap and, on a Mac, the scroll wheel; none on a still picture.
private struct BoardGestures<Pan: Gesture>: ViewModifier {
    let live: Bool
    let pan: Pan
    let pinch: (CGFloat, CGPoint?, Bool) -> Void
    let double: (CGPoint) -> Void
    let wheel: (CGFloat, CGFloat, Bool, CGPoint) -> Void

    func body(content: Content) -> some View {
        if live {
            content
                .gesture(pan)
                .modifier(Pinch(pinch: pinch))
                .gesture(SpatialTapGesture(count: 2).onEnded { double($0.location) })
                #if os(macOS)
                .background(WheelCatcher(wheel: wheel))
                #endif
        } else {
            content.allowsHitTesting(false)
        }
    }
}

private struct Pinch: ViewModifier {
    let pinch: (CGFloat, CGPoint?, Bool) -> Void

    func body(content: Content) -> some View {
        if #available(iOS 17, macOS 14, *) {
            content.simultaneousGesture(
                MagnifyGesture()
                    .onChanged { pinch($0.magnification, $0.startLocation, false) }
                    .onEnded { _ in pinch(1, nil, true) }
            )
        } else {
            content.simultaneousGesture(
                MagnificationGesture()
                    .onChanged { pinch($0, nil, false) }
                    .onEnded { _ in pinch(1, nil, true) }
            )
        }
    }
}

#if os(macOS)
/// The scroll wheel over the board: two fingers pan, with ⌘ they zoom. Clicks pass through.
private struct WheelCatcher: NSViewRepresentable {
    let wheel: (CGFloat, CGFloat, Bool, CGPoint) -> Void

    func makeNSView(context: Context) -> WheelView { WheelView() }
    func updateNSView(_ view: WheelView, context: Context) { view.wheel = wheel }

    final class WheelView: NSView {
        var wheel: (CGFloat, CGFloat, Bool, CGPoint) -> Void = { _, _, _, _ in }
        private var monitor: Any?
        override var isFlipped: Bool { true }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] e in
                guard let self, e.window === self.window else { return e }
                let p = self.convert(e.locationInWindow, from: nil)
                guard self.bounds.contains(p) else { return e }
                let k: CGFloat = e.hasPreciseScrollingDeltas ? 1 : 8
                self.wheel(e.scrollingDeltaX * k, e.scrollingDeltaY * k, e.modifierFlags.contains(.command), p)
                return nil
            }
        }

        deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
    }
}
#endif

// MARK: - Blocks and lines

/// The frames of the blocks and the lines between nodes, under the nodes.
struct LoopLines: View {
    let ctx: LoopContext
    let camera: LoopCamera
    let rects: [String: CGRect]
    let filter: LoopFilter
    let allLines: Bool
    let selected: String?

    var body: some View {
        Canvas { g, _ in
            let z = camera.zoom
            for b in ctx.view.blocks ?? [] {
                let f = camera.screen(LoopGeo.frame(b))
                let c = LoopInk.block(b.key)
                let shape = Path(roundedRect: f, cornerRadius: 22 * z)
                g.fill(shape, with: .color(c.opacity(0.05)))
                g.stroke(shape, with: .color(c.opacity(0.28)), lineWidth: max(0.6, z))
            }
            let labels = z >= 0.35
            for e in ctx.edges {
                guard let a = rects[e.source], let b = rects[e.target] else { continue }
                let look = LoopLineLook.of(e, ctx)
                let ends = selected == e.source || selected == e.target
                guard !look.quiet || allLines || ends || look.shownIn(filter) else { continue }
                let r = LoopRoute.between(a, b, edge: e, look: look, ctx: ctx)
                let path = r.path.applying(camera.transform)
                let width = max(0.7, look.width * z)
                let dash = look.dash.map { max(1, $0 * z) }
                let style = StrokeStyle(lineWidth: ends ? width * 1.6 : width, lineCap: look.round ? .round : .butt, lineJoin: .round, dash: dash)
                g.stroke(path, with: .color(look.color), style: style)
                draw(end: look.end, at: r.end, dir: r.dir, color: look.color, zoom: z, in: &g)
                if labels, let tag = e.label?.nonEmpty ?? look.tag {
                    let p = r.mid.applying(camera.transform)
                    pill(tag, at: p, color: look.tagColor ?? look.color, zoom: z, in: &g)
                }
            }
        }
        .allowsHitTesting(false)
    }

    private func draw(end: LoopLineLook.End, at p: CGPoint, dir: CGVector, color: Color, zoom: CGFloat, in g: inout GraphicsContext) {
        let len = max(hypot(dir.dx, dir.dy), 0.0001)
        let u = CGVector(dx: dir.dx / len, dy: dir.dy / len)
        let n = CGVector(dx: -u.dy, dy: u.dx)
        let t = camera.transform
        switch end {
        case .arrow:
            let s: CGFloat = 9
            var a = Path()
            a.move(to: CGPoint(x: p.x + u.dx, y: p.y + u.dy).applying(t))
            a.addLine(to: CGPoint(x: p.x - u.dx * s + n.dx * s / 2, y: p.y - u.dy * s + n.dy * s / 2).applying(t))
            a.addLine(to: CGPoint(x: p.x - u.dx * s - n.dx * s / 2, y: p.y - u.dy * s - n.dy * s / 2).applying(t))
            a.closeSubpath()
            g.fill(a, with: .color(color))
        case .bar:
            var a = Path()
            a.move(to: CGPoint(x: p.x + n.dx * 7, y: p.y + n.dy * 7).applying(t))
            a.addLine(to: CGPoint(x: p.x - n.dx * 7, y: p.y - n.dy * 7).applying(t))
            g.stroke(a, with: .color(color), lineWidth: max(1, 2.4 * zoom))
        case .none:
            break
        }
    }

    private func pill(_ text: String, at p: CGPoint, color: Color, zoom: CGFloat, in g: inout GraphicsContext) {
        let size = max(9, min(12, 11 * zoom * 1.3))
        let t = g.resolve(Text(text).font(.system(size: size, weight: .semibold)).foregroundColor(color))
        let m = t.measure(in: CGSize(width: 400, height: 40))
        let r = CGRect(x: p.x - m.width / 2 - 6, y: p.y - m.height / 2 - 2.5, width: m.width + 12, height: m.height + 5)
        let shape = Path(roundedRect: r, cornerRadius: r.height / 2)
        g.fill(shape, with: .color(LoopInk.panel))
        g.stroke(shape, with: .color(color.opacity(0.45)), lineWidth: 1)
        g.draw(t, at: p)
    }
}

/// How a line looks: by its kind and the state of what it joins (Canvas.tsx, canvas.css).
struct LoopLineLook {
    enum End { case arrow, bar, none }
    var color: Color
    var width: CGFloat
    var dash: [CGFloat] = []
    var round = false
    var end: End = .arrow
    var arc = false
    /// Drawn only for a selected node, with every line shown, or in the filter it belongs to.
    var quiet = false
    var tag: String? = nil
    var tagColor: Color? = nil
    var kind: String?

    func shownIn(_ f: LoopFilter) -> Bool {
        switch f {
        case .hard: return kind == "clamp"
        case .soft: return kind == "watch" || kind == "spec"
        default: return false
        }
    }

    static func of(_ e: LoopEdge, _ ctx: LoopContext) -> LoopLineLook {
        let a = ctx.nodes[e.source], b = ctx.nodes[e.target], lang = ctx.lang
        switch e.kind {
        case "flow":
            var look = LoopLineLook(color: Color.primary.opacity(0.4), width: 2.4, kind: e.kind)
            if let a {
                if a.kind == "stage", a.status == "done" { look.color = LoopInk.pass }
                if let g = a.gate {
                    let l = LoopRead.gateLook(g)
                    if l == "pass" { look.color = LoopInk.pass } else if l == "warn" { look.color = LoopInk.amber }
                    if b?.locked != nil, g.state == "block", g.waived != true {
                        look.color = LoopInk.muted
                        look.dash = [7, 6]
                        look.tag = "🔒 " + lang.string("canvas.edge.locked")
                    }
                }
            }
            return look
        case "watch":
            let k = a?.check.map { $0.status } ?? "none"
            var look = LoopLineLook(color: LoopInk.tone(k == "fail" ? "fail" : k), width: 1.6, dash: [3, 4], kind: e.kind)
            look.quiet = !(k == "warn" || k == "fail")
            return look
        case "spec":
            return LoopLineLook(color: LoopInk.spec, width: 1.6, dash: [5, 4], quiet: true, kind: e.kind)
        case "clamp":
            return LoopLineLook(color: LoopInk.clamp, width: 2, end: .bar, quiet: true, kind: e.kind)
        case "escalate":
            let from = a?.gate?.stage ?? a?.ref
            let on = ctx.view.nodes.first { $0.kind == "human" }?.items?.contains { $0.gate != nil && $0.gate == from } ?? false
            return LoopLineLook(color: LoopInk.amber.opacity(on ? 1 : 0.4), width: 1.6, dash: [4, 5], quiet: !on, kind: e.kind)
        case "member":
            return LoopLineLook(color: LoopInk.hard.opacity(0.35), width: 1.4, dash: [1, 4], round: true, end: .none, kind: e.kind)
        case "hard_loop":
            let t = b?.kind == "task" ? b : a
            let done = t?.converged == true
            var look = LoopLineLook(color: done ? LoopInk.muted : LoopInk.hard, width: 2.6, dash: [8, 5], arc: true, kind: e.kind)
            if b?.kind == "task", let t {
                look.tag = done ? lang.format("canvas.edge.converged", max(1, t.round ?? 1)) : lang.format("canvas.edge.rework", max(1, t.round ?? 1))
            }
            return look
        case "soft_loop":
            var look = LoopLineLook(color: LoopInk.amber, width: 2, dash: [1, 6], round: true, arc: true, kind: e.kind)
            if b?.kind == "task" { look.tag = lang.string("canvas.edge.soft") }
            return look
        case "order":
            let st = a?.status
            var look = LoopLineLook(color: st == "sent" ? LoopInk.brand : st == "done" ? LoopInk.pass : st == "blocked" ? LoopInk.hard : LoopInk.muted, width: 2.2, kind: e.kind)
            if a?.stale != nil { look.color = LoopInk.amber; look.dash = [6, 4] }
            if b?.status == "queued" {
                look.tag = lang.string(st == "blocked" ? "canvas.edge.blocked" : a?.stale != nil ? "canvas.edge.stale" : "canvas.edge.wait")
            }
            return look
        case "assigned":
            return LoopLineLook(color: LoopInk.brand.opacity(0.45), width: 1.4, dash: [6, 4], end: .none, kind: e.kind)
        default:
            if a?.kind == "note" || b?.kind == "note" {
                return LoopLineLook(color: LoopInk.amber, width: 1.6, dash: [2, 4], round: true, kind: e.kind)
            }
            if a?.kind == "task" || b?.kind == "task" {
                return LoopLineLook(color: LoopInk.brand, width: 1.8, dash: [6, 4], kind: e.kind)
            }
            if a?.kind == "info" || b?.kind == "info" {
                return LoopLineLook(color: LoopInk.muted, width: 1.6, dash: [1, 5], round: true, kind: e.kind)
            }
            return LoopLineLook(color: Color.gray, width: 1.6, kind: e.kind)
        }
    }
}

/// The path of a line, in canvas coordinates: across a row as a curve, between rows down the gap between them with
/// rounded corners, a loop back as an arc.
struct LoopRoute {
    var path: Path
    var end: CGPoint
    var dir: CGVector
    var mid: CGPoint

    static func between(_ a: CGRect, _ b: CGRect, edge: LoopEdge, look: LoopLineLook, ctx: LoopContext) -> LoopRoute {
        let down = a.maxY + 30 < b.minY, up = b.maxY + 30 < a.minY
        if look.arc {
            let (s, e) = (down || up) ? vertical(a, b, down: down) : horizontal(a, b)
            let len = hypot(e.x - s.x, e.y - s.y)
            let bend = min(110, len * 0.3)
            let m = CGPoint(x: (s.x + e.x) / 2, y: (s.y + e.y) / 2)
            let n = CGVector(dx: -(e.y - s.y) / max(len, 1), dy: (e.x - s.x) / max(len, 1))
            let c = CGPoint(x: m.x + n.dx * bend, y: m.y + n.dy * bend)
            var p = Path()
            p.move(to: s)
            p.addQuadCurve(to: e, control: c)
            return LoopRoute(path: p, end: e, dir: CGVector(dx: e.x - c.x, dy: e.y - c.y),
                             mid: CGPoint(x: 0.25 * s.x + 0.5 * c.x + 0.25 * e.x, y: 0.25 * s.y + 0.5 * c.y + 0.25 * e.y))
        }
        if down || up {
            let (s, e) = vertical(a, b, down: down)
            let sign: CGFloat = down ? 1 : -1
            if look.kind == "flow" {
                // down the gap between the two rows when the line leaves its block
                let gap = gapY(edge, down: down, ctx: ctx) ?? (s.y + e.y) / 2
                let r = min(14, abs(e.x - s.x) / 2, abs(gap - s.y), abs(e.y - gap))
                var p = Path()
                p.move(to: s)
                if abs(e.x - s.x) < 1 {
                    p.addLine(to: e)
                } else {
                    p.addArc(tangent1End: CGPoint(x: s.x, y: gap), tangent2End: CGPoint(x: e.x, y: gap), radius: r)
                    p.addArc(tangent1End: CGPoint(x: e.x, y: gap), tangent2End: e, radius: r)
                    p.addLine(to: e)
                }
                return LoopRoute(path: p, end: e, dir: CGVector(dx: 0, dy: sign), mid: CGPoint(x: (s.x + e.x) / 2, y: gap))
            }
            let k = max(30, abs(e.y - s.y) / 2)
            let c1 = CGPoint(x: s.x, y: s.y + k * sign), c2 = CGPoint(x: e.x, y: e.y - k * sign)
            var p = Path()
            p.move(to: s)
            p.addCurve(to: e, control1: c1, control2: c2)
            return LoopRoute(path: p, end: e, dir: CGVector(dx: e.x - c2.x, dy: e.y - c2.y), mid: cubic(s, c1, c2, e))
        }
        let (s, e) = horizontal(a, b)
        let k = max(30, abs(e.x - s.x) / 2) * (e.x >= s.x ? 1 : -1)
        let c1 = CGPoint(x: s.x + k, y: s.y), c2 = CGPoint(x: e.x - k, y: e.y)
        var p = Path()
        p.move(to: s)
        p.addCurve(to: e, control1: c1, control2: c2)
        return LoopRoute(path: p, end: e, dir: CGVector(dx: e.x - c2.x, dy: e.y - c2.y), mid: cubic(s, c1, c2, e))
    }

    private static func vertical(_ a: CGRect, _ b: CGRect, down: Bool) -> (CGPoint, CGPoint) {
        down ? (CGPoint(x: a.midX, y: a.maxY), CGPoint(x: b.midX, y: b.minY))
            : (CGPoint(x: a.midX, y: a.minY), CGPoint(x: b.midX, y: b.maxY))
    }

    private static func horizontal(_ a: CGRect, _ b: CGRect) -> (CGPoint, CGPoint) {
        b.midX >= a.midX ? (CGPoint(x: a.maxX, y: a.midY), CGPoint(x: b.minX, y: b.midY))
            : (CGPoint(x: a.minX, y: a.midY), CGPoint(x: b.maxX, y: b.midY))
    }

    /// Halfway between the frames of the two blocks a line runs between, when they are in different rows.
    private static func gapY(_ e: LoopEdge, down: Bool, ctx: LoopContext) -> CGFloat? {
        guard let ma = ctx.nodes[e.source]?.mod, let mb = ctx.nodes[e.target]?.mod, ma != mb,
              let fa = ctx.blocks[ma].map(LoopGeo.frame), let fb = ctx.blocks[mb].map(LoopGeo.frame) else { return nil }
        if down, fa.maxY <= fb.minY { return (fa.maxY + fb.minY) / 2 }
        if !down, fb.maxY <= fa.minY { return (fb.maxY + fa.minY) / 2 }
        return nil
    }

    private static func cubic(_ p0: CGPoint, _ p1: CGPoint, _ p2: CGPoint, _ p3: CGPoint) -> CGPoint {
        CGPoint(x: 0.125 * p0.x + 0.375 * p1.x + 0.375 * p2.x + 0.125 * p3.x,
                y: 0.125 * p0.y + 0.375 * p1.y + 0.375 * p2.y + 0.125 * p3.y)
    }
}

/// A block's name and how its part of the flow stands, over its frame. Drawn at a readable size at any zoom; tapping
/// it zooms to the block.
struct LoopBlockHead: View {
    let block: LoopBlock
    let ctx: LoopContext
    let camera: LoopCamera
    let live: Bool
    let focus: () -> Void

    var body: some View {
        let f = camera.screen(LoopGeo.frame(block))
        let z = camera.zoom
        let size = max(10, 15 * z)
        let c = LoopInk.block(block.key)
        let pills = z >= 0.25 ? LoopRead.pills(block.key, ctx) : []
        let part = z >= 0.5 ? LoopRead.partLine(block.key, ctx) : ""
        // far out the name is taller than the block's header and runs over its first cards: it gets a ground of its own
        let over = size * 1.6 > LoopGeo.head * z
        HStack(spacing: size * 0.5) {
            Image(systemName: LoopInk.symbol(block.key))
                .font(.system(size: size * 0.85, weight: .semibold))
                .foregroundStyle(c)
            Text(ctx.lang.server(block.title))
                .font(.system(size: size, weight: .semibold))
                .fixedSize()
            ForEach(Array(pills.enumerated()), id: \.offset) { _, p in
                Text(p.0)
                    .font(.system(size: size * 0.72, weight: .semibold))
                    .foregroundStyle(p.1)
                    .padding(.horizontal, size * 0.4)
                    .padding(.vertical, size * 0.12)
                    .background(Capsule().fill(p.1.opacity(0.12)))
                    .fixedSize()
            }
            if !part.isEmpty {
                Text(part)
                    .font(.system(size: size * 0.75))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, over ? 5 : 0)
        .padding(.vertical, over ? 1 : 0)
        .background(RoundedRectangle(cornerRadius: 5).fill(LoopInk.panel.opacity(over ? 0.92 : 0)))
        .padding(.horizontal, max(6, LoopGeo.pad * z - (over ? 5 : 0)))
        .frame(width: max(0, f.width), height: max(size * 1.6, LoopGeo.head * z), alignment: .leading)
        .clipped()
        .contentShape(Rectangle())
        .onTapGesture { if live { focus() } }
        .position(x: f.midX, y: f.minY + max(size * 1.6, LoopGeo.head * z) / 2)
    }
}

extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
