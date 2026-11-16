import AppKit
import SwiftUI
import WebKit

// The town's page in a WKWebView, made to behave as it does in a browser tab: links to other sites
// open in your browser; a link that opens a new tab opens a window (a PDF) or saves a download (a
// project's files) into Downloads; confirm(), alert() and prompt() get dialogs; file pickers, full
// screen and the 3D walk's hold on the mouse work.
@MainActor
final class Page: NSObject {
    let web: WKWebView
    var origin: URL? // the server; any other address opens in the browser
    var onFinish: (() -> Void)?
    var onFail: ((Error) -> Void)?
    var onLang: ((Lang) -> Void)?
    var onLook: ((NSColor, Bool) -> Void)? // the colour of the page's top bar, and whether it is dark
    private var popups: [WKWebView: NSWindow] = [:]
    private var titles: [WKWebView: NSKeyValueObservation] = [:]
    private var downloads = Set<WKDownload>()
    private var saved: [WKDownload: URL] = [:]

    init(lang: Lang) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.preferences.isElementFullscreenEnabled = true
        config.applicationNameForUserAgent = "Papertown/\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev")"
        // the page starts in English unless told otherwise (web/src/i18n.ts); here it starts in the
        // Mac's language, until one is picked in its settings
        config.userContentController.addUserScript(WKUserScript(source: """
            try { localStorage.getItem('papertown.lang') || localStorage.setItem('papertown.lang', '\(lang.rawValue)') } catch {}
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: .zero, configuration: config)
        web.isInspectable = true
        web.underPageBackgroundColor = .paper
        web.pageZoom = UserDefaults.standard.object(forKey: "zoom") as? Double ?? 1
        super.init()
        web.navigationDelegate = self
        web.uiDelegate = self
        web.configuration.userContentController.add(self, name: "look")
    }

    func load(_ url: URL) {
        origin = url
        web.load(URLRequest(url: url))
    }

    // the page listens for these (web/src/App.tsx): open its settings, change view, show a toast
    func send(_ detail: [String: String]) {
        guard let json = try? JSONSerialization.data(withJSONObject: detail), let s = String(data: json, encoding: .utf8) else { return }
        web.evaluateJavaScript("dispatchEvent(new CustomEvent('papertown:command', { detail: \(s) }))", completionHandler: nil)
    }

    func toast(_ text: String) { send(["type": "toast", "text": text]) }

    // something typed and not sent yet, which a reload would lose
    func writing() async -> Bool {
        let js = """
            (() => { const a = document.activeElement;
              return !!(a && (a.isContentEditable || (a.tagName === 'INPUT' && a.value)))
                || [...document.querySelectorAll('textarea')].some(t => t.value.trim()) })()
            """
        return (try? await web.evaluateJavaScript(js)) as? Bool ?? false
    }

    // a browser's zoom steps: 1 bigger, -1 smaller, 0 actual size
    func zoom(_ step: Int) {
        let steps = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3], z = web.pageZoom
        web.pageZoom = step == 0 ? 1 : step > 0 ? steps.first { $0 > z + 0.01 } ?? z : steps.last { $0 < z - 0.01 } ?? z
        UserDefaults.standard.set(web.pageZoom, forKey: "zoom")
    }

    private func outside(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), !["about", "blob", "data", "javascript"].contains(scheme) else { return false }
        guard scheme == "http" || scheme == "https", let origin else { return true }
        let local = ["127.0.0.1", "localhost"]
        return !(url.host == origin.host || local.contains(url.host ?? "") && local.contains(origin.host ?? "")) || url.port != origin.port
    }

    private func present(_ alert: NSAlert, over webView: WKWebView, _ done: @escaping (NSApplication.ModalResponse) -> Void) {
        if let window = webView.window, window.isVisible {
            alert.beginSheetModal(for: window, completionHandler: done)
        } else {
            done(alert.runModal())
        }
    }

    private func dialog(_ message: String, cancel: Bool) -> NSAlert {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: t("好"))
        if cancel { a.addButton(withTitle: t("取消")).keyEquivalent = "\u{1b}" }
        return a
    }
}

// the page says which look it has whenever that changes (web/src/settings.ts), and the window takes
// it up: what shows past the page's edges, the strip under the title bar, light or dark
extension Page: WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let look = message.body as? [String: Any], let bar = (look["bar"] as? String).flatMap(NSColor.init(hex:)) else { return }
        let strip = look["ui"] as? String == "paper" ? NSColor.hud : bar // the paper's top bar is not its page colour
        web.underPageBackgroundColor = strip
        onLook?(strip, look["dark"] as? Bool ?? false)
    }
}

extension Page: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { return decisionHandler(.download) }
        if let url = action.request.url, action.targetFrame?.isMainFrame != false, outside(url) {
            NSWorkspace.shared.open(url)
            if let window = popups[webView], !window.isVisible { window.close() }
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    // a project's files are sent as attachments: saved, as a browser would
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        decisionHandler(!response.canShowMIMEType || disposition.lowercased().hasPrefix("attachment") ? .download : .allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        adopt(download, from: webView)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        adopt(download, from: webView)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        // a new window shows once there is something to show, so a download never flashes one
        if let window = popups[webView], !window.isVisible { window.makeKeyAndOrderFront(nil) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === web else { return }
        web.evaluateJavaScript("document.documentElement.lang") { [weak self] value, _ in
            if let lang = (value as? String).flatMap(Lang.init(rawValue:)) { self?.onLang?(lang) }
        }
        onFinish?()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(webView, error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(webView, error)
    }

    private func failed(_ webView: WKWebView, _ error: Error) {
        let e = error as NSError
        // cancelled, or turned into a download: not a failure
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled || e.domain == WKError.errorDomain && e.code == 102 { return }
        if webView === web { onFail?(error) }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}

extension Page: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, outside(url) {
            NSWorkspace.shared.open(url)
            return nil
        }
        let popup = WKWebView(frame: .zero, configuration: configuration)
        popup.navigationDelegate = self
        popup.uiDelegate = self
        popup.isInspectable = true
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 1080), styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        window.contentView = popup
        window.delegate = self
        window.tabbingMode = .disallowed
        if let main = web.window {
            window.setFrameTopLeftPoint(NSPoint(x: main.frame.minX + 40, y: main.frame.maxY - 40))
            window.setFrame(window.frame.intersection(main.screen?.visibleFrame ?? window.frame), display: false)
        } else {
            window.center()
        }
        popups[popup] = window
        titles[popup] = popup.observe(\.title) { [weak window] w, _ in
            MainActor.assumeIsolated { window?.title = w.title.flatMap { $0.isEmpty ? nil : $0 } ?? "Papertown" }
        }
        return popup
    }

    func webViewDidClose(_ webView: WKWebView) {
        popups[webView]?.close()
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        present(dialog(message, cancel: false), over: webView) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        present(dialog(message, cancel: true), over: webView) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let a = dialog(prompt, cancel: true)
        let field = NSTextField(string: defaultText ?? "")
        field.frame.size.width = 280
        a.accessoryView = field
        a.window.initialFirstResponder = field
        present(a, over: webView) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let p = NSOpenPanel()
        p.allowsMultipleSelection = parameters.allowsMultipleSelection
        p.canChooseDirectories = parameters.allowsDirectories
        if let window = webView.window {
            p.beginSheetModal(for: window) { completionHandler($0 == .OK ? p.urls : nil) }
        } else {
            completionHandler(p.runModal() == .OK ? p.urls : nil)
        }
    }

    // the microphone, for Paseo's voice input in the agents' room (its page is on this machine too)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(["127.0.0.1", "localhost"].contains(origin.host) ? .grant : .prompt)
    }

    // The 3D walk holds the mouse to look round (requestPointerLock). WKWebView has no public way to
    // allow that; WebKit asks its delegate through this private call, as Safari answers it.
    @objc(_webViewDidRequestPointerLock:completionHandler:)
    func webViewDidRequestPointerLock(_ webView: WKWebView, completionHandler: @escaping (Bool) -> Void) {
        completionHandler(true)
    }
}

extension Page: WKDownloadDelegate {
    private func adopt(_ download: WKDownload, from webView: WKWebView) {
        download.delegate = self
        downloads.insert(download)
        if let window = popups[webView], !window.isVisible { window.close() }
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let name = (suggestedFilename as NSString).deletingPathExtension, ext = (suggestedFilename as NSString).pathExtension
        var url = dir.appendingPathComponent(suggestedFilename)
        var n = 1
        while FileManager.default.fileExists(atPath: url.path) {
            n += 1
            url = dir.appendingPathComponent(ext.isEmpty ? "\(name) \(n)" : "\(name) \(n).\(ext)")
        }
        saved[download] = url
        completionHandler(url)
    }

    func downloadDidFinish(_ download: WKDownload) {
        downloads.remove(download)
        guard let url = saved.removeValue(forKey: download) else { return }
        // the Dock's Downloads stack bounces, as it does for a browser's
        DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: url.path)
        toast(t("已下载 {0}，在「下载」文件夹里", url.lastPathComponent))
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.remove(download)
        saved.removeValue(forKey: download)
        toast(t("下载失败：{0}", error.localizedDescription))
    }
}

extension Page: NSWindowDelegate {
    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, let popup = popups.first(where: { $0.value === window })?.key else { return }
        popup.stopLoading()
        popups[popup] = nil
        titles[popup] = nil
    }
}

// the page shown in the main window; the same WKWebView each time the window opens, so closing
// the window and opening it again keeps your place
struct PageView: NSViewRepresentable {
    let page: Page
    func makeNSView(context: Context) -> WKWebView { page.web }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
