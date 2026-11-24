import PapertownCore
import SwiftUI

// The nodes of the research loop's canvas, kind by kind, as web/src/progress/LoopNodes.tsx and CanvasInfo.tsx draw
// them. Each is laid out at its canvas size and scaled with the board.

/// What the canvas draws from: the loop, the project's progress card and what its stages produced.
struct LoopContext {
    let view: LoopView
    let card: ProjectCardView?
    let outputs: ProjectOutputs?
    let lang: AppLanguage
    let nodes: [String: LoopNode]
    let checks: [String: ResearchCheck]
    let blocks: [String: LoopBlock]
    /// The loop's lines, and one from each task with no session of its own to the agent card of the role it goes to.
    let edges: [LoopEdge]

    init(view: LoopView, card: ProjectCardView?, outputs: ProjectOutputs?, lang: AppLanguage) {
        self.view = view
        self.card = card
        self.outputs = outputs
        self.lang = lang
        nodes = Dictionary(view.nodes.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        checks = Dictionary((view.checks ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        blocks = Dictionary((view.blocks ?? []).map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        let ids = Set(view.nodes.map(\.id))
        let assigned = view.nodes.compactMap { n -> LoopEdge? in
            guard n.kind == "task", n.agentID == nil, ids.contains("info:agent:\(n.to ?? "lead")") else { return nil }
            return LoopEdge(id: "as:\(n.id)", source: n.id, target: "info:agent:\(n.to ?? "lead")", kind: "assigned")
        }
        edges = (view.edges ?? []) + assigned
    }

    func gateChecks(_ g: LoopGate) -> [ResearchCheck] { (g.checks ?? []).compactMap { checks[$0] } }
}

/// What the loop says about its pieces, in common (web/src/progress/loop.ts).
enum LoopRead {
    static let stages = TextFormatters.orderedStages

    /// A gate let through reads as let through.
    static func gateLook(_ g: LoopGate) -> String { g.waived == true && g.state == "block" ? "warn" : g.state }

    static func bad(_ c: ResearchCheck) -> Bool { c.on && ["fail", "warn"].contains(c.status) }

    /// A hard check at its gate: passes, only warns, or blocks the next stage.
    static func level(_ c: ResearchCheck) -> String {
        !c.on ? "off" : bad(c) ? (c.gate == "block" ? "block" : "warn") : c.status == "pass" ? "pass" : "none"
    }

    /// What on the loop wants you.
    static func needs(_ n: LoopNode) -> Bool {
        if n.kind == "gate" { return n.gate.map { ["block", "warn"].contains(gateLook($0)) } ?? false }
        if let c = n.check { return c.on && (["fail", "warn"].contains(c.status) || c.due == true) }
        if n.kind == "task" { return n.status != "done" || n.stale != nil }
        if n.kind == "stage" { return n.locked != nil }
        if n.kind == "human" { return !(n.items ?? []).isEmpty }
        return false
    }

    static func side(_ n: LoopNode) -> String {
        if ["gate", "hard", "clamp"].contains(n.kind) || n.loop == "hard" { return "hard" }
        if ["soft", "spec"].contains(n.kind) || n.loop == "soft" { return "soft" }
        return ["stage", "human"].contains(n.kind) ? "both" : "none"
    }

    static func shown(_ n: LoopNode, _ f: LoopFilter) -> Bool {
        switch f {
        case .all: return true
        case .needs: return needs(n)
        case .hard: return ["hard", "both"].contains(side(n))
        case .soft: return ["soft", "both"].contains(side(n))
        }
    }

    /// A node's name in a list or a sheet.
    static func name(_ n: LoopNode, _ ctx: LoopContext) -> String {
        let lang = ctx.lang
        switch n.kind {
        case "stage": return TextFormatters.stageName(n.ref ?? "", language: lang)
        case "gate": return lang.format("canvas.gate.short", TextFormatters.stageName(n.gate?.stage ?? n.ref ?? "", language: lang))
        case "hard", "soft": return lang.server(n.check?.title ?? n.title)
        case "note": return clip(n.text ?? "", 30)
        default: return lang.server(n.title ?? n.id)
        }
    }

    /// A block's header in a few words: its stages, the worst of its gates, its sentinels, its tasks, and in the
    /// overview what waits for you.
    static func pills(_ key: String, _ ctx: LoopContext) -> [(String, Color)] {
        let lang = ctx.lang
        let ns = ctx.view.nodes.filter { $0.mod == key }
        var out: [(String, Color)] = []
        let stages = ns.filter { $0.kind == "stage" }, tasks = ns.filter { $0.kind == "task" }
        if !stages.isEmpty {
            let done = stages.filter { $0.status == "done" }.count
            out.append((lang.format("canvas.pill.stages", done, stages.count),
                        done == stages.count ? LoopInk.pass : stages.contains { $0.status == "run" } ? LoopInk.brand : LoopInk.muted))
        }
        let looks = ns.compactMap { $0.kind == "gate" ? $0.gate.map(gateLook) : nil }
        if looks.contains("block") {
            out.append((lang.string("canvas.pill.block"), LoopInk.hard))
        } else if looks.contains("warn") {
            out.append((lang.string("canvas.pill.warn"), LoopInk.amber))
        } else if !looks.isEmpty, looks.allSatisfy({ $0 == "pass" }) {
            out.append((lang.string("canvas.pill.pass"), LoopInk.pass))
        }
        let off = ns.filter { $0.kind == "soft" && ($0.check.map { $0.on && ["warn", "fail"].contains($0.status) } ?? false) }.count
        if off > 0 { out.append((lang.format("canvas.pill.soft", off), LoopInk.amber)) }
        if !tasks.isEmpty {
            let open = tasks.filter { $0.status != "done" }.count
            let stuck = tasks.filter { $0.status == "blocked" || $0.stale != nil }.count
            if stuck > 0 {
                out.append((lang.format("canvas.pill.tasks.stuck", tasks.count, stuck), LoopInk.hard))
            } else if open > 0 {
                out.append((lang.format("canvas.pill.tasks.open", tasks.count, open), LoopInk.brand))
            } else {
                out.append((lang.format("canvas.pill.tasks.done", tasks.count), LoopInk.pass))
            }
        }
        if key == "overview", let n = ctx.view.nodes.first(where: { $0.kind == "human" })?.items?.count, n > 0 {
            out.append((lang.format("loop.human", n), LoopInk.amber))
        }
        return out
    }

    /// What the project has in a part of the flow: its repository, runs, paper, agents.
    static func partLine(_ key: String, _ ctx: LoopContext) -> String {
        let lang = ctx.lang, r = ctx.card
        switch key {
        case "overview":
            guard let c = r?.card else { return "" }
            return [c.progress.map { "\($0)%" }, c.milestone.map(lang.server)].compactMap { $0?.nonEmpty }.joined(separator: " · ")
        case "code":
            guard let code = r?.repos?.code, code.missing != true else { return lang.string("canvas.part.nocode") }
            return [code.name, code.branch ?? "", (code.dirty ?? 0) > 0 ? lang.format("canvas.part.changes", code.dirty ?? 0) : ""]
                .filter { !$0.isEmpty }.joined(separator: " · ")
        case "exp":
            return runs(ctx)
        case "paper":
            guard let paper = r?.repos?.paper, paper.missing != true else { return lang.string("canvas.part.nopaper") }
            return [paper.main ?? paper.name, (paper.words ?? 0) > 0 ? lang.format("canvas.info.words", words(paper.words ?? 0)) : ""]
                .filter { !$0.isEmpty }.joined(separator: " · ")
        case "agents":
            return there(ctx)
        default:
            return ""
        }
    }

    static func runs(_ ctx: LoopContext) -> String {
        let lang = ctx.lang
        let running = ctx.card?.running?.count ?? 0, queued = ctx.card?.queued?.count ?? 0
        return [running > 0 ? lang.format("canvas.part.running", running) : "", queued > 0 ? lang.format("canvas.part.queued", queued) : ""]
            .filter { !$0.isEmpty }.joined(separator: " · ")
    }

    static func there(_ ctx: LoopContext) -> String {
        let roles = ["lead", "coder", "writer"].filter { ctx.view.agents?[$0]?.there == true }
        return roles.isEmpty ? ctx.lang.string("canvas.part.noagent")
            : roles.map { TextFormatters.roleName($0, language: ctx.lang) }.joined(separator: " · ")
    }

    /// The line under a stage's name: what it has produced.
    static func stationLine(_ n: LoopNode, _ ctx: LoopContext) -> String {
        let lang = ctx.lang, r = ctx.card
        if let l = n.locked { return lang.format("canvas.stage.locked", TextFormatters.stageName(l.gate, language: lang)) }
        switch n.ref {
        case "exp":
            let s = runs(ctx)
            if !s.isEmpty { return s }
        case "write", "ship":
            if let paper = r?.repos?.paper, paper.missing != true {
                return n.ref == "write"
                    ? [paper.main ?? "", (paper.words ?? 0) > 0 ? lang.format("canvas.info.words", words(paper.words ?? 0)) : ""].filter { !$0.isEmpty }.joined(separator: " · ")
                    : paper.title ?? paper.name
            }
        case "method":
            if let code = r?.repos?.code, code.missing != true, let b = code.branch { return b }
        case "team":
            return there(ctx)
        default:
            break
        }
        return lang.server(n.note ?? "")
    }

    static func words(_ n: Int) -> String { n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : "\(n)" }

    static func number(_ v: Double?) -> String {
        guard let v else { return "—" }
        return v == v.rounded() ? String(Int(v)) : String(format: abs(v) < 1 ? "%.3f" : "%.2f", v)
    }

    static func clip(_ s: String, _ n: Int) -> String {
        let t = s.replacingOccurrences(of: "\n", with: " ")
        return t.count > n ? String(t.prefix(n)) + "…" : t
    }
}

// MARK: - A node

struct LoopNodeView: View {
    let node: LoopNode
    let ctx: LoopContext
    let detail: LoopDetail
    let zoom: CGFloat
    let selected: Bool

    var body: some View {
        let look = NodeLook.of(node, ctx)
        ZStack(alignment: .topLeading) {
            look.shape.fill(LoopInk.panel)
            if let tint = look.tint { look.shape.fill(tint) }
            if let bar = look.bar {
                HStack(spacing: 0) { bar.frame(width: look.barWidth); Spacer(minLength: 0) }
                    .clipShape(look.shape)
            }
            look.shape.stroke(look.stroke, style: StrokeStyle(lineWidth: look.width, dash: look.dash))
            if node.kind == "soft" {
                RoundedRectangle(cornerRadius: 36)
                    .stroke(look.stroke.opacity(0.5), style: StrokeStyle(lineWidth: 1.2, dash: [4, 4]))
                    .padding(-6)
            }
            if node.escalated == true {
                RoundedRectangle(cornerRadius: 15).stroke(LoopInk.amber, lineWidth: 2).padding(-4)
            }
            if detail == .far {
                FarLabel(title: look.farTitle, figure: look.farFigure, zoom: zoom)
            } else {
                content(small: detail == .near)
            }
            if selected {
                look.shape.stroke(LoopInk.brand, lineWidth: 3).padding(-3)
            }
        }
        .opacity(look.opacity)
        .foregroundStyle(.primary)
    }

    @ViewBuilder
    private func content(small: Bool) -> some View {
        switch node.kind {
        case "stage": StageBody(n: node, ctx: ctx, small: small)
        case "gate": GateBody(n: node, ctx: ctx, small: small)
        case "hard": HardBody(n: node, ctx: ctx, small: small)
        case "soft": SoftBody(n: node, ctx: ctx, small: small)
        case "spec": SpecBody(n: node, ctx: ctx, small: small)
        case "clamp": ClampBody(n: node, ctx: ctx, small: small)
        case "human": HumanBody(n: node, ctx: ctx, small: small)
        case "task": TaskBody(n: node, ctx: ctx, small: small)
        case "note":
            Text(LoopRead.clip(node.text ?? "", 120))
                .font(.system(size: 13))
                .lineLimit(4)
                .padding(12)
        default: InfoCard(n: node, ctx: ctx, small: small)
        }
    }
}

/// Far out: the name and one figure, large enough to read.
private struct FarLabel: View {
    let title: String
    let figure: String
    let zoom: CGFloat

    var body: some View {
        let k = min(2.6, 0.85 / max(zoom, 0.01))
        // too small to read even so: the shape and its colour say enough
        if 15 * k * zoom >= 6 {
            VStack(spacing: 2 * k) {
                Text(title).font(.system(size: 15 * k, weight: .semibold)).lineLimit(2).multilineTextAlignment(.center)
                if !figure.isEmpty {
                    Text(figure).font(.system(size: 13 * k, weight: .medium).monospacedDigit()).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .minimumScaleFactor(0.5)
            .padding(8)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// A node's outline and colours, and what it says far out.
private struct NodeLook {
    var shape: AnyShape
    var stroke: Color
    var width: CGFloat = 1.5
    var dash: [CGFloat] = []
    var tint: Color? = nil
    var bar: Color? = nil
    var barWidth: CGFloat = 5
    var opacity: Double = 1
    var farTitle: String
    var farFigure: String = ""

    static func of(_ n: LoopNode, _ ctx: LoopContext) -> NodeLook {
        let lang = ctx.lang
        let title = LoopRead.name(n, ctx)
        switch n.kind {
        case "stage":
            let st = n.status ?? "todo", pct = Int(n.pct ?? 0)
            let c = n.locked != nil ? LoopInk.muted : st == "done" ? LoopInk.pass : st == "run" ? LoopInk.brand : LoopInk.muted
            return NodeLook(shape: AnyShape(RoundedRectangle(cornerRadius: 14)), stroke: c, dash: st == "todo" ? [5, 4] : [],
                            bar: c, opacity: st == "todo" && n.locked == nil ? 0.85 : 1, farTitle: title,
                            farFigure: n.locked != nil ? lang.string("canvas.locked") : st == "run" ? "\(pct)%" : "")
        case "gate":
            let g = n.gate
            let look = g.map(LoopRead.gateLook) ?? "none"
            let cs = g.map(ctx.gateChecks) ?? []
            let one = cs.count == 1 ? cs[0] : nil
            let figure = one.map { c in c.last?.value.map { "\(LoopRead.number($0))/\(LoopRead.number(c.max ?? 0))" } ?? "" }
                ?? ((g?.total ?? 0) > 0 ? "\(g?.pass ?? 0)/\(g?.total ?? 0)" : "")
            let c = gateColor(look)
            return NodeLook(shape: AnyShape(Octagon(cut: 13)), stroke: c, width: 2, tint: c.opacity(0.06), opacity: look == "off" ? 0.55 : 1,
                            farTitle: one.map { lang.server($0.title) } ?? title, farFigure: figure)
        case "hard":
            let lv = n.check.map(LoopRead.level) ?? "none"
            let c = gateColor(lv)
            let v = n.check?.last?.value
            return NodeLook(shape: AnyShape(Octagon(cut: 10)), stroke: c, width: 2, tint: c.opacity(0.06), opacity: lv == "off" ? 0.55 : 1,
                            farTitle: title, farFigure: v.map { "\(LoopRead.number($0))/\(LoopRead.number(n.check?.max ?? 0))" } ?? "")
        case "soft":
            let k = n.check?.status ?? "none"
            let c = k == "pass" ? LoopInk.pass : k == "warn" ? LoopInk.amber : k == "fail" ? LoopInk.hard : LoopInk.muted
            return NodeLook(shape: AnyShape(RoundedRectangle(cornerRadius: 30)), stroke: c, width: 2, tint: c.opacity(0.05),
                            opacity: n.check?.on == false ? 0.5 : 1, farTitle: title,
                            farFigure: ["pass", "warn", "fail"].contains(k) ? lang.string("canvas.verdict.\(k)") : "")
        case "spec":
            let count = n.rules?.count ?? 0
            return NodeLook(shape: AnyShape(RoundedRectangle(cornerRadius: 10)), stroke: LoopInk.spec, dash: [5, 4], tint: LoopInk.spec.opacity(0.05),
                            farTitle: lang.string("canvas.spec.far"), farFigure: count > 0 ? lang.format("canvas.rules.n", count) : "")
        case "clamp":
            let count = n.rules?.count ?? 0
            return NodeLook(shape: AnyShape(RoundedRectangle(cornerRadius: 10)), stroke: LoopInk.clamp, width: 2,
                            farTitle: lang.string("canvas.clamp.far"), farFigure: count > 0 ? lang.format("canvas.rules.n", count) : "")
        case "human":
            let count = n.items?.count ?? 0
            return NodeLook(shape: AnyShape(Hexagon(point: 26)), stroke: LoopInk.amber.opacity(count > 0 ? 1 : 0.45), width: 2,
                            tint: count > 0 ? LoopInk.amber.opacity(0.10) : nil,
                            farTitle: lang.string("canvas.human.far"), farFigure: count > 0 ? lang.format("canvas.human.n", count) : "")
        case "task":
            let st = n.status ?? "draft"
            var c = st == "sent" ? LoopInk.brand : st == "done" ? LoopInk.ok : st == "blocked" ? LoopInk.hard : st == "queued" ? LoopInk.amber : LoopInk.muted
            if n.loop == "hard" { c = LoopInk.hard } else if n.loop == "soft" { c = LoopInk.amber }
            if n.converged == true { c = LoopInk.muted }
            let dashed = st == "draft" || st == "queued" || n.stale != nil
            let figure = n.converged == true ? lang.string("canvas.task.converged")
                : n.escalated == true ? lang.string("canvas.task.escalated")
                : n.stale != nil ? lang.string("canvas.task.recheck") : taskState(st, lang)
            return NodeLook(shape: AnyShape(RoundedRectangle(cornerRadius: 12)), stroke: n.stale != nil ? LoopInk.amber : c,
                            dash: dashed ? [5, 4] : [], bar: c, barWidth: n.loop != nil ? 6 : 4,
                            opacity: n.converged == true ? 0.7 : 1, farTitle: title, farFigure: figure)
        case "note":
            return NodeLook(shape: AnyShape(NoteShape()), stroke: LoopInk.amber.opacity(0.45), width: 1, tint: LoopInk.amber.opacity(0.13),
                            farTitle: LoopRead.clip(n.text ?? "", 24))
        default:
            return NodeLook(shape: AnyShape(RoundedRectangle(cornerRadius: 12)), stroke: LoopInk.line, width: 1, farTitle: title)
        }
    }

    static func gateColor(_ look: String) -> Color {
        switch look {
        case "pass": return LoopInk.pass
        case "warn": return LoopInk.amber
        case "block": return LoopInk.hard
        default: return LoopInk.muted
        }
    }

    static func taskState(_ st: String, _ lang: AppLanguage) -> String {
        switch st {
        case "sent": return lang.string("canvas.task.sent")
        default: return lang.string("loop.task.\(st)")
        }
    }
}

// MARK: - Shapes

struct Octagon: Shape {
    var cut: CGFloat
    func path(in r: CGRect) -> Path {
        let c = min(cut, r.width / 2, r.height / 2)
        var p = Path()
        p.move(to: CGPoint(x: r.minX + c, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX - c, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.minY + c))
        p.addLine(to: CGPoint(x: r.maxX, y: r.maxY - c))
        p.addLine(to: CGPoint(x: r.maxX - c, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX + c, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX, y: r.maxY - c))
        p.addLine(to: CGPoint(x: r.minX, y: r.minY + c))
        p.closeSubpath()
        return p
    }
}

struct Hexagon: Shape {
    var point: CGFloat
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.minX + point, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX - point, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.midY))
        p.addLine(to: CGPoint(x: r.maxX - point, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX + point, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX, y: r.midY))
        p.closeSubpath()
        return p
    }
}

/// A note: square corners but the bottom right, which curls.
struct NoteShape: Shape {
    func path(in r: CGRect) -> Path {
        let s: CGFloat = 3, big: CGFloat = 14
        var p = Path()
        p.move(to: CGPoint(x: r.minX + s, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX - s, y: r.minY))
        p.addQuadCurve(to: CGPoint(x: r.maxX, y: r.minY + s), control: CGPoint(x: r.maxX, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.maxY - big))
        p.addQuadCurve(to: CGPoint(x: r.maxX - big, y: r.maxY), control: CGPoint(x: r.maxX, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX + s, y: r.maxY))
        p.addQuadCurve(to: CGPoint(x: r.minX, y: r.maxY - s), control: CGPoint(x: r.minX, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX, y: r.minY + s))
        p.addQuadCurve(to: CGPoint(x: r.minX + s, y: r.minY), control: CGPoint(x: r.minX, y: r.minY))
        p.closeSubpath()
        return p
    }
}

// MARK: - Pieces

/// The small capitals over a node: what kind it is and how it stands.
private struct Head: View {
    let text: String
    var chip: String? = nil
    var chipColor: Color = LoopInk.muted
    var symbol: String? = nil
    var color: Color = .secondary

    var body: some View {
        HStack(spacing: 5) {
            if let symbol { Image(systemName: symbol).font(.system(size: 10, weight: .bold)).foregroundStyle(color) }
            Text(text)
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(color)
                .lineLimit(1)
            Spacer(minLength: 4)
            if let chip { Chip(text: chip, color: chipColor) }
        }
    }
}

private struct Chip: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 1.5)
            .background(Capsule().fill(color.opacity(0.13)))
            .lineLimit(1)
            .fixedSize()
    }
}

private struct StageBody: View {
    let n: LoopNode
    let ctx: LoopContext
    let small: Bool

    var body: some View {
        let st = n.status ?? "todo", pct = st == "done" ? 100 : Int(n.pct ?? 0)
        let c = n.locked != nil ? LoopInk.muted : st == "done" ? LoopInk.pass : st == "run" ? LoopInk.brand : LoopInk.muted
        let index = (LoopRead.stages.firstIndex(of: n.ref ?? "") ?? 0) + 1
        let line = LoopRead.stationLine(n, ctx)
        ZStack(alignment: .topLeading) {
            HStack(spacing: 12) {
                ZStack {
                    Circle().stroke(c.opacity(0.2), lineWidth: 4)
                    Circle().trim(from: 0, to: CGFloat(pct) / 100).stroke(c, style: StrokeStyle(lineWidth: 4, lineCap: .round)).rotationEffect(.degrees(-90))
                    if n.locked != nil {
                        Image(systemName: "lock.fill").font(.system(size: 13, weight: .semibold)).foregroundStyle(c)
                    } else if st == "done" {
                        Image(systemName: "checkmark").font(.system(size: 14, weight: .bold)).foregroundStyle(c)
                    } else {
                        Text("\(pct)%").font(.system(size: 11, weight: .bold).monospacedDigit())
                    }
                }
                .frame(width: 38, height: 38)
                VStack(alignment: .leading, spacing: 2) {
                    if small {
                        Text(String(format: "STAGE %02d", index)).font(.system(size: 10, weight: .semibold, design: .monospaced)).foregroundStyle(.secondary)
                    }
                    Text(TextFormatters.stageName(n.ref ?? "", language: ctx.lang)).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                    if small, !line.isEmpty {
                        Text(line).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.leading, 18)
            .padding(.trailing, 10)
            .frame(maxHeight: .infinity)
            if let role = n.role {
                let there = ctx.view.agents?[role]?.there == true
                HStack(spacing: 4) {
                    Circle().fill(there ? LoopInk.ok : LoopInk.muted).frame(width: 6, height: 6)
                    Text(TextFormatters.roleName(role, language: ctx.lang)).font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.top, 8)
                .padding(.trailing, 10)
            }
            if st == "run" {
                VStack {
                    Spacer()
                    GeometryReader { g in
                        Capsule().fill(c).frame(width: g.size.width * CGFloat(pct) / 100, height: 3)
                    }
                    .frame(height: 3)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 6)
                }
            }
        }
    }
}

private struct GateBody: View {
    let n: LoopNode
    let ctx: LoopContext
    let small: Bool

    var body: some View {
        let lang = ctx.lang
        if let g = n.gate {
            let cs = ctx.gateChecks(g), on = cs.filter(\.on), look = LoopRead.gateLook(g)
            let one = cs.count == 1 ? cs[0] : nil
            let prios = Set(on.compactMap(\.prio)).sorted().joined(separator: "/")
            let chip = g.waived == true && g.state == "block" ? lang.string("canvas.gate.waived") : lang.string("loop.gate.\(look)")
            VStack(alignment: .leading, spacing: 5) {
                Head(text: "◆ HARD · \(prios.isEmpty ? "P1" : prios)", chip: chip, chipColor: NodeLook.gateColor(look))
                HStack(alignment: .firstTextBaseline) {
                    Text(one.map { lang.server($0.title) } ?? lang.format("canvas.gate.group", TextFormatters.stageName(g.stage, language: lang)))
                        .font(.system(size: 14, weight: .semibold)).lineLimit(1)
                    Spacer(minLength: 4)
                    Text(one.map { c in c.last?.value.map { "\(LoopRead.number($0)) / ≤\(LoopRead.number(c.max ?? 0))" } ?? "—" }
                         ?? lang.format("canvas.gate.pass_n", g.pass ?? 0, g.total ?? 0))
                        .font(.system(size: 12, weight: .semibold).monospacedDigit())
                        .foregroundStyle(NodeLook.gateColor(look))
                }
                if one == nil, !cs.isEmpty {
                    HStack(spacing: 3) {
                        ForEach(cs.prefix(16)) { c in
                            let lv = LoopRead.level(c), col = NodeLook.gateColor(lv)
                            RoundedRectangle(cornerRadius: 2)
                                .fill(["pass", "warn", "block"].contains(lv) ? col : Color.clear)
                                .overlay(RoundedRectangle(cornerRadius: 2).stroke(col.opacity(lv == "off" ? 0.35 : 0.8), lineWidth: 1))
                                .frame(width: 11, height: 11)
                        }
                    }
                }
                if small {
                    Text(footnote(g, look)).font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
    }

    private func footnote(_ g: LoopGate, _ look: String) -> String {
        let lang = ctx.lang
        let before = g.before ?? 0, now = g.now ?? 0
        var s = before > now ? lang.format("canvas.gate.trail", before, ctx.view.rounds ?? 1, now)
            : now > 0 ? lang.format("canvas.gate.left", now)
            : look == "none" ? lang.string("canvas.gate.empty") : lang.string("canvas.gate.clear")
        if g.ticket != nil, (g.round ?? 0) > 0, g.waived != true, look == "block" { s += " · " + lang.format("loop.round.n", g.round ?? 0) }
        return s
    }
}

private struct HardBody: View {
    let n: LoopNode
    let ctx: LoopContext
    let small: Bool

    var body: some View {
        let lang = ctx.lang
        if let c = n.check {
            let lv = LoopRead.level(c), v = c.last?.value
            VStack(alignment: .leading, spacing: 4) {
                Head(text: "HARD · \(c.prio ?? "")", chip: lang.string("loop.gate.\(lv)"), chipColor: NodeLook.gateColor(lv))
                HStack(alignment: .firstTextBaseline) {
                    Text(lang.server(c.title)).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    Spacer(minLength: 4)
                    Text(v.map { "\(LoopRead.number($0)) / ≤\(LoopRead.number(c.max ?? 0))" } ?? "—")
                        .font(.system(size: 11.5, weight: .semibold).monospacedDigit())
                        .foregroundStyle(NodeLook.gateColor(lv))
                }
                if small, let f = c.last?.findings?.first, let file = f.file {
                    Text("\(file):\(f.line ?? 0)").font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 7)
        }
    }
}

private struct SoftBody: View {
    let n: LoopNode
    let ctx: LoopContext
    let small: Bool

    var body: some View {
        let lang = ctx.lang
        if let c = n.check {
            let k = c.on ? c.status : "off"
            let watched = ctx.edges.first { $0.kind == "watch" && $0.source == n.id }.flatMap { ctx.nodes[$0.target] }
            let what = watched.map { lang.format("canvas.soft.watch", LoopRead.name($0, ctx)) } ?? lang.string("canvas.soft.ask")
            let every = LoopRead.number(c.every ?? 24)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                    Text("SOFT · \(what) · \(lang.format("canvas.soft.every", every))")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 4)
                    if c.due == true { Chip(text: lang.string("canvas.soft.due"), color: LoopInk.brand) }
                    Chip(text: lang.string("canvas.verdict.\(k)"), color: LoopInk.tone(k))
                }
                HStack {
                    Text(lang.server(c.title)).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                    Spacer(minLength: 4)
                    HStack(spacing: 3) {
                        ForEach(Array((c.history ?? []).suffix(4).enumerated()), id: \.offset) { _, h in
                            Circle().fill(LoopInk.tone(h.status)).frame(width: 7, height: 7)
                        }
                    }
                }
                if small {
                    Text(LoopRead.clip(c.last?.note ?? lang.server(c.text ?? ""), 46))
                        .font(.system(size: 11)).italic().foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 10)
        }
    }
}

private struct SpecBody: View {
    let n: LoopNode
    let ctx: LoopContext
    let small: Bool

    var body: some View {
        let lang = ctx.lang, rules = n.rules ?? []
        VStack(alignment: .leading, spacing: 4) {
            Head(text: "SOFT SPEC · Prompt / AGENTS.md", color: LoopInk.spec)
            Text(rules.first.map { LoopRead.clip($0.text, 30) } ?? lang.string("canvas.spec.empty"))
                .font(.system(size: 13.5, weight: .semibold)).lineLimit(1)
            if small {
                Text(rules.isEmpty ? lang.string("canvas.spec.none") : lang.format("canvas.spec.count", rules.count))
                    .font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(12)
    }
}

private struct ClampBody: View {
    let n: LoopNode
    let ctx: LoopContext
    let small: Bool

    var body: some View {
        let lang = ctx.lang, rules = n.rules ?? []
        VStack(alignment: .leading, spacing: 0) {
            Text("HARD CLAMP · \(lang.string("canvas.clamp.title"))")
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(LoopInk.panel)
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity, minHeight: 22, alignment: .leading)
                .background(LoopInk.clamp)
            VStack(alignment: .leading, spacing: 3) {
                Text(rules.isEmpty ? lang.string("canvas.clamp.empty") : rules.prefix(2).map { LoopRead.clip($0.text, 16) }.joined(separator: " · "))
                    .font(.system(size: 13, weight: .semibold)).lineLimit(1)
                if small {
                    Text(lang.format("canvas.clamp.count", rules.count)).font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

private struct HumanBody: View {
    let n: LoopNode
    let ctx: LoopContext
    let small: Bool

    var body: some View {
        let lang = ctx.lang, items = n.items ?? []
        VStack(alignment: .leading, spacing: 4) {
            Head(text: "HUMAN GATE · \(lang.string("canvas.human.title"))", symbol: "person.fill", color: LoopInk.amber)
            Text(items.isEmpty ? lang.string("canvas.human.empty") : lang.format("loop.human", items.count))
                .font(.system(size: 14, weight: .semibold)).lineLimit(1)
            if small {
                Text(items.first.map { LoopRead.clip(lang.server($0.text), 40) } ?? lang.string("canvas.human.hint"))
                    .font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.horizontal, 32)
        .padding(.vertical, 10)
    }
}

private struct TaskBody: View {
    let n: LoopNode
    let ctx: LoopContext
    let small: Bool

    var body: some View {
        let lang = ctx.lang, st = n.status ?? "draft"
        let head = n.loop == "hard" ? lang.format("canvas.task.hard", max(1, n.round ?? 1))
            : n.loop == "soft" ? lang.string("canvas.task.soft") : lang.string("canvas.task")
        let who = TextFormatters.roleName(n.to ?? "lead", language: lang)
        let chip = n.converged == true ? lang.string("canvas.task.converged")
            : n.escalated == true ? lang.string("canvas.task.escalated") : NodeLook.taskState(st, lang)
        let chipColor = n.escalated == true ? LoopInk.amber : LoopInk.tone(st)
        let symbol = n.loop == "hard" ? "arrow.triangle.2.circlepath" : n.loop == "soft" ? "sparkle" : nil
        VStack(alignment: .leading, spacing: 3) {
            Head(text: "\(head) · \(n.id) · \(who)", chip: chip, chipColor: chipColor, symbol: symbol)
            Text(n.title ?? "").font(.system(size: 13.5, weight: .semibold)).lineLimit(2)
            if st == "queued" {
                Label(wait(lang), systemImage: "clock").font(.system(size: 11)).foregroundStyle(LoopInk.amber).lineLimit(1)
            }
            if n.stale != nil {
                Label(lang.string("canvas.task.stale"), systemImage: "arrow.clockwise").font(.system(size: 11)).foregroundStyle(LoopInk.amber).lineLimit(1)
            }
            if small {
                if n.loop == "hard", let trail = n.trail, !trail.isEmpty {
                    Text(lang.format("canvas.task.trail", trail.map { lang.format("canvas.places", $0) }.joined(separator: " → ")))
                        .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                } else if let t = n.text, !t.isEmpty {
                    Text(LoopRead.clip(t, 96)).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                }
                let when = st == "sent" ? n.sentAt : st == "draft" ? nil : n.doneAt
                if let when {
                    Text(TextFormatters.relativeTime(from: when, language: lang)).font(.system(size: 10)).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 10)
        .padding(.vertical, 8)
    }

    private func wait(_ lang: AppLanguage) -> String {
        if n.waitNote != nil { return lang.string("canvas.task.retry") }
        guard let w = n.waits?.first else { return lang.string("loop.task.queued") }
        if w.kind == "dir" { return lang.format("canvas.task.wait_dir", w.id) }
        return lang.format("canvas.task.wait", (n.waits ?? []).map(\.id).joined(separator: "、"))
    }
}

// MARK: - Info cards

/// A card showing the project as it stands in a part of the flow: its progress, an agent, runs, code, paper and the
/// rest (CanvasInfo.tsx). `small`: with its small print.
struct InfoCard: View {
    let n: LoopNode
    let ctx: LoopContext
    let small: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: InfoCard.symbol(kind)).font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
                Text(ctx.lang.server(n.title ?? "")).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Spacer(minLength: 4)
                if let s = InfoCard.state(n, ctx) { Chip(text: s.0, color: s.1) }
            }
            InfoBody(n: n, ctx: ctx, full: false)
                .font(.system(size: 12))
            Spacer(minLength: 0)
        }
        .padding(12)
        .mask(LinearGradient(stops: [.init(color: .black, location: 0.8), .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom))
    }

    private var kind: String { InfoCard.kind(n) }

    static func kind(_ n: LoopNode) -> String { String((n.ref ?? "").split(separator: ":").first ?? "") }

    static func symbol(_ k: String) -> String {
        switch k {
        case "card": return "chart.bar.doc.horizontal"
        case "outputs": return "shippingbox"
        case "agent": return "person.crop.circle"
        case "survey": return "books.vertical"
        case "method": return "function"
        case "code": return "chevron.left.forwardslash.chevron.right"
        case "runs": return "play.circle"
        case "results": return "chart.xyaxis.line"
        case "datasets": return "tablecells"
        case "paper": return "doc.richtext"
        default: return "doc"
        }
    }

    /// The few words in a card's header: how the thing stands.
    static func state(_ n: LoopNode, _ ctx: LoopContext) -> (String, Color)? {
        let lang = ctx.lang, r = ctx.card
        switch kind(n) {
        case "card":
            guard let h = r?.card?.health, !h.isEmpty else { return nil }
            return (lang.string("health.\(h)"), Tone.color(h))
        case "agent":
            let role = String((n.ref ?? "").split(separator: ":").last ?? "")
            guard let a = ctx.view.agents?[role], a.there == true else { return (lang.string("canvas.info.nostart"), LoopInk.muted) }
            return (lang.server(a.status ?? ""), LoopInk.ok)
        case "survey":
            guard let v = ctx.outputs?.hatch?.verdict, !v.isEmpty else { return nil }
            return (lang.server(v), LoopInk.brand)
        case "runs":
            let k = r?.running?.count ?? 0
            return k > 0 ? (lang.format("canvas.part.running", k), LoopInk.brand) : nil
        case "code", "paper":
            let x = kind(n) == "code" ? r?.repos?.code : r?.repos?.paper
            guard let x, x.missing != true, let d = x.dirty, d > 0 else { return nil }
            return (lang.format("canvas.part.changes", d), LoopInk.amber)
        case "outputs":
            let o = r?.card?.outputs ?? []
            return o.isEmpty ? nil : ("\(o.filter { $0.state == "done" }.count)/\(o.count)", LoopInk.muted)
        default:
            return nil
        }
    }
}

/// What an info card holds; `full` in its sheet, a few lines on the canvas.
struct InfoBody: View {
    let n: LoopNode
    let ctx: LoopContext
    let full: Bool

    var body: some View {
        let lang = ctx.lang, r = ctx.card, out = ctx.outputs
        VStack(alignment: .leading, spacing: 5) {
            switch InfoCard.kind(n) {
            case "card":
                Text(lang.server(r?.line.title ?? ctx.view.title ?? "")).fontWeight(.semibold).lineLimit(full ? nil : 2)
                if let c = r?.card {
                    if !c.summary.isEmpty { Text(lang.server(c.summary)).foregroundStyle(.secondary).lineLimit(full ? nil : 2) }
                    if let p = c.progress {
                        ProgressView(value: Double(p), total: 100).tint(LoopInk.brand)
                        Text("\(p)%" + (c.milestone.map { " · " + lang.server($0) } ?? "")).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                    let need = (r?.decisions ?? []).map { lang.server($0.title) }
                    if full || !need.isEmpty { list(lang.string("canvas.info.need"), need, LoopInk.amber) }
                    if full || need.isEmpty && !c.blockers.isEmpty { list(lang.string("canvas.info.blockers"), c.blockers.map(lang.server), LoopInk.hard) }
                    if full || need.isEmpty && c.blockers.isEmpty { list(lang.string("canvas.info.next"), c.next.map(lang.server), .secondary) }
                    if full { list(lang.string("canvas.info.done"), c.done.map(lang.server), LoopInk.pass) }
                } else {
                    Text(lang.string("canvas.info.nocard")).foregroundStyle(.secondary)
                }
            case "outputs":
                let o = r?.card?.outputs ?? [], m = r?.card?.metrics ?? []
                if o.isEmpty && m.isEmpty { Text(lang.string("canvas.info.nooutputs")).foregroundStyle(.secondary) }
                ForEach(Array(o.prefix(full ? 50 : 4).enumerated()), id: \.offset) { _, x in
                    HStack(spacing: 6) {
                        Circle().fill(LoopInk.tone(x.state == "done" ? "pass" : x.state == "doing" ? "run" : "none")).frame(width: 7, height: 7)
                        Text(lang.server(x.name)).lineLimit(1)
                    }
                }
                ForEach(Array(m.prefix(full ? 50 : 3).enumerated()), id: \.offset) { _, x in
                    HStack {
                        Text(lang.server(x.name)).foregroundStyle(.secondary).lineLimit(1)
                        Spacer(minLength: 4)
                        Text(x.value).monospacedDigit().foregroundStyle(LoopInk.pass)
                    }
                }
            case "agent":
                let role = String((n.ref ?? "").split(separator: ":").last ?? "")
                let a = ctx.view.agents?[role]
                let tasks = ctx.view.nodes.filter { $0.kind == "task" && ($0.to ?? "lead") == role }
                if let model = a?.model, !model.isEmpty { Text(model).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1) }
                if !tasks.isEmpty {
                    Text(lang.format("canvas.info.tasks", tasks.count, tasks.filter { $0.status == "done" }.count)).foregroundStyle(.secondary)
                }
            case "survey":
                if let h = out?.hatch {
                    if let gap = h.gap ?? h.summary { Text(lang.server(gap)).foregroundStyle(.secondary).lineLimit(full ? nil : 5) }
                    if full, let s = h.suggestions, !s.isEmpty { list(lang.string("canvas.info.next"), s.map(lang.server), .secondary) }
                } else {
                    Text(lang.string("canvas.info.nosurvey")).foregroundStyle(.secondary)
                }
            case "method":
                if let m = out?.method {
                    if let p = m.problem { Text(lang.server(p)).lineLimit(full ? nil : 2) }
                    ForEach(Array((m.mechanism ?? []).prefix(full ? 20 : 3).enumerated()), id: \.offset) { i, step in
                        Text("\(i + 1). \(lang.server(step))").foregroundStyle(.secondary).lineLimit(full ? nil : 1)
                    }
                    if full, let b = m.baselines, !b.isEmpty { list(lang.string("canvas.info.baselines"), b.map(\.name), .secondary) }
                    if full, let x = m.metrics, !x.isEmpty { list(lang.string("canvas.info.metrics"), x.map(lang.server), .secondary) }
                } else {
                    Text(lang.string("canvas.info.nomethod")).foregroundStyle(.secondary)
                }
            case "code":
                repo(r?.repos?.code, empty: lang.string("canvas.part.nocode"))
            case "paper":
                repo(r?.repos?.paper, empty: lang.string("canvas.info.nopaper"))
            case "runs":
                let running = r?.running ?? [], queued = r?.queued ?? []
                if running.isEmpty && queued.isEmpty { Text(lang.string("canvas.info.noruns")).foregroundStyle(.secondary) }
                ForEach(running.prefix(full ? 30 : 3)) { run in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(run.name).lineLimit(1)
                        if let p = run.progress { ProgressView(value: min(max(p, 0), 1)).tint(LoopInk.brand) }
                    }
                }
                if !queued.isEmpty { Text(lang.format("canvas.part.queued", queued.count)).foregroundStyle(.secondary) }
            case "results":
                results(out?.exp)
            case "datasets":
                let sets = out?.method?.datasets ?? []
                if sets.isEmpty {
                    Text(lang.string("canvas.info.nodata")).foregroundStyle(.secondary)
                } else {
                    ChipFlow(spacing: 5, lineSpacing: 5) {
                        ForEach(Array(sets.prefix(full ? 40 : 6).enumerated()), id: \.offset) { _, s in
                            Text(s).font(.system(size: 11)).padding(.horizontal, 7).padding(.vertical, 2)
                                .background(Capsule().fill(LoopInk.block("data").opacity(0.12)))
                        }
                    }
                }
            default:
                EmptyView()
            }
        }
    }

    @ViewBuilder
    private func list(_ title: String, _ items: [String], _ color: Color) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.caption2.weight(.semibold)).foregroundStyle(color)
                ForEach(Array(items.prefix(full ? 50 : 2).enumerated()), id: \.offset) { _, x in
                    Text("· " + x).lineLimit(full ? nil : 1)
                }
            }
        }
    }

    @ViewBuilder
    private func repo(_ x: CardRepo?, empty: String) -> some View {
        if let x, x.missing != true {
            Text(x.title ?? x.name).fontWeight(.semibold).lineLimit(1)
            Text([x.branch ?? "", (x.dirty ?? 0) > 0 ? ctx.lang.format("canvas.part.changes", x.dirty ?? 0) : "",
                  (x.words ?? 0) > 0 ? ctx.lang.format("canvas.info.words", LoopRead.words(x.words ?? 0)) : ""]
                .filter { !$0.isEmpty }.joined(separator: " · "))
                .foregroundStyle(.secondary).lineLimit(1)
            if full { Text(x.path).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary) }
        } else {
            Text(empty).foregroundStyle(.secondary)
        }
    }

    /// Ours against the best baseline, metric by metric.
    @ViewBuilder
    private func results(_ t: ResultsTable?) -> some View {
        let lang = ctx.lang
        if let t, !t.rows.isEmpty, !t.metrics.isEmpty {
            let ours = t.rows.first { $0.ours == true }
            let others = t.rows.filter { $0.ours != true }
            ForEach(Array(t.metrics.prefix(full ? 20 : 3).enumerated()), id: \.offset) { i, m in
                let best = others.compactMap { $0.values.indices.contains(i) ? $0.values[i] : nil }.max()
                let mine = ours.flatMap { $0.values.indices.contains(i) ? $0.values[i] : nil }
                HStack {
                    Text(lang.server(m)).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 4)
                    Text(LoopRead.number(mine)).monospacedDigit().fontWeight(.semibold).foregroundStyle(LoopInk.pass)
                    Text("/ " + LoopRead.number(best)).monospacedDigit().foregroundStyle(.secondary)
                }
            }
            Text("\(lang.string("canvas.info.ours")) / \(lang.string("canvas.info.best"))").font(.caption2).foregroundStyle(.tertiary)
        } else {
            Text(lang.string("canvas.info.noresults")).foregroundStyle(.secondary)
        }
    }
}
