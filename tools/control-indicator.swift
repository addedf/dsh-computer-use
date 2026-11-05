// DSH's own transient control panel. No screen-capture API is used here.
import AppKit
import Foundation

func emit(_ value: [String: Any]) {
    guard let bytes = try? JSONSerialization.data(withJSONObject: value),
          let newline = "\n".data(using: .utf8) else { return }
    FileHandle.standardOutput.write(bytes + newline)
}

final class StopTarget: NSObject {
    let owner: String
    weak var panel: NSPanel?
    init(owner: String) { self.owner = owner }
    @objc func stop() {
        stopped.insert(owner)
        panel?.orderOut(nil)
        emit(["event": "stop", "owner": owner])
    }
}

final class Indicator {
    let panel: NSPanel
    let label: NSTextField
    let target: StopTarget
    var lastWindow: NSDictionary?

    init(owner: String) {
        target = StopTarget(owner: owner)
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 254, height: 44),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        // This panel contains only our control status and Stop button. Allow
        // screenshots so the user can inspect the visible-control evidence.
        panel.sharingType = .readOnly
        panel.title = "DSH 控制状态"

        let material = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: 254, height: 44))
        material.material = .hudWindow
        material.blendingMode = .behindWindow
        material.state = .active
        material.wantsLayer = true
        material.layer?.cornerRadius = 12
        material.layer?.masksToBounds = true
        panel.contentView = material

        let icon = NSImageView(frame: NSRect(x: 12, y: 12, width: 20, height: 20))
        icon.image = NSImage(systemSymbolName: "cursorarrow.motionlines", accessibilityDescription: "DSH 电脑控制")
        icon.contentTintColor = .systemPurple
        material.addSubview(icon)

        label = NSTextField(labelWithString: "DSH 正在操作")
        label.frame = NSRect(x: 42, y: 12, width: 142, height: 20)
        label.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        label.lineBreakMode = .byTruncatingTail
        material.addSubview(label)

        let button = NSButton(title: "停止", target: target, action: #selector(StopTarget.stop))
        button.frame = NSRect(x: 188, y: 9, width: 56, height: 26)
        button.bezelStyle = .rounded
        button.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        button.toolTip = "停止当前会话的电脑操作"
        button.setAccessibilityLabel("停止 DSH 控制")
        material.addSubview(button)
        target.panel = panel
    }

    func place(_ bounds: [String: Any]?) {
        if let bounds = bounds {
            let dictionary = bounds as NSDictionary
            if lastWindow?.isEqual(to: bounds) == true { return }
            lastWindow = dictionary
            if let x = bounds["x"] as? Double, let y = bounds["y"] as? Double,
               let width = bounds["width"] as? Double, let height = bounds["height"] as? Double,
               x.isFinite, y.isFinite, width.isFinite, height.isFinite, width > 0, height > 0 {
                let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
                let rectangle = NSRect(x: x, y: primaryTop - y - height, width: width, height: height)
                let screen = NSScreen.screens.first(where: { $0.frame.intersects(rectangle) }) ?? NSScreen.main
                position(x: x + 88, y: primaryTop - y - panel.frame.height - 6, screen: screen)
                return
            }
        } else if panel.isVisible { return }
        let screen = NSScreen.main ?? NSScreen.screens.first
        let frame = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1024, height: 768)
        position(x: frame.minX + 12, y: frame.maxY - panel.frame.height - 12, screen: screen)
    }

    private func position(x: CGFloat, y: CGFloat, screen: NSScreen?) {
        let safe = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1024, height: 768)
        panel.setFrameOrigin(NSPoint(x: min(max(x, safe.minX + 4), max(safe.minX + 4, safe.maxX - panel.frame.width - 4)),
                                     y: min(max(y, safe.minY + 4), max(safe.minY + 4, safe.maxY - panel.frame.height - 4))))
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.applicationIconImage = NSImage(systemSymbolName: "cursorarrow.motionlines", accessibilityDescription: "DSH Control")
var indicators: [String: Indicator] = [:]
var stopped = Set<String>()

func command(_ object: [String: Any]) {
    guard let operation = object["op"] as? String else { return }
    if operation == "shutdown" { app.terminate(nil); return }
    guard let owner = object["owner"] as? String, owner.count < 100 else { return }
    if operation == "hide" { indicators.removeValue(forKey: owner)?.panel.orderOut(nil); return }
    guard operation == "update", !stopped.contains(owner),
          let revision = object["revision"] as? Int,
          let phase = object["status"] as? String else { return }
    let labels = ["preparing": "DSH 准备操作", "observing": "DSH 正在观察", "acting": "DSH 正在操作", "waiting": "DSH 等待确认", "idle": "DSH 等待下一步", "paused": "DSH 已暂停"]
    guard let label = labels[phase] else { return }
    let indicator = indicators[owner] ?? Indicator(owner: owner)
    indicators[owner] = indicator
    indicator.label.stringValue = label
    indicator.place(object["window"] as? [String: Any])
    indicator.panel.orderFrontRegardless()
    emit(["event": "visible", "owner": owner, "revision": revision])
}

DispatchQueue.global(qos: .utility).async {
    while let line = readLine(strippingNewline: true) {
        if line.utf8.count > 8192 { continue }
        guard let bytes = line.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any] else { continue }
        DispatchQueue.main.async { command(object) }
    }
    DispatchQueue.main.async { app.terminate(nil) }
}
emit(["event": "ready"])
app.run()
