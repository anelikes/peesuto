import Foundation
import XCTest
@testable import PeesutoKit

final class LyricMotionTests: XCTestCase {
    private var directory: URL!
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("peesuto-lyric-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: directory) }

    private func write(_ json: String) throws {
        try Data(json.utf8).write(to: directory.appendingPathComponent("settings.json"))
    }

    /// As `templates.list` sends them (abridged): auto, JIZURA's with one horror style, the classic ones.
    static let stylesJSON = #"""
    [
      {"id":"auto","engine":"jizura","name":{"en":"Auto","ja":"おまかせ","zh-Hans":"自动"},"description":{"en":"JIZURA picks a style and a mood from the text","ja":"文字から JIZURA がスタイルと雰囲気を選びます","zh-Hans":"由 JIZURA 按文字挑选风格与氛围"}},
      {"id":"noir","engine":"jizura","name":{"en":"Noir","ja":"ノワール","zh-Hans":"黑色"},"description":{"en":"Black and white","ja":"白黒","zh-Hans":"黑白"}},
      {"id":"sakura","engine":"jizura","name":{"en":"Sakura","ja":"桜","zh-Hans":"樱"},"extra":true},
      {"id":"hrRuin","engine":"jizura","name":{"en":"Ruin","ja":"廃墟","zh-Hans":"废墟"},"horror":true},
      {"id":"classic","engine":"classic","name":{"en":"Stage","ja":"ステージ","zh-Hans":"舞台"}},
      {"id":"editorial","engine":"classic","name":{"en":"Paper","ja":"ペーパー","zh-Hans":"纸面"}},
      {"id":"pop","engine":"classic","name":{"en":"Pop","ja":"ポップ","zh-Hans":"波普"}},
      {"id":"night","engine":"classic","name":{"en":"Night","ja":"ナイト","zh-Hans":"夜"}}
    ]
    """#
    static var styles: [CoreLyricStyle] { try! JSONDecoder().decode([CoreLyricStyle].self, from: Data(stylesJSON.utf8)) }

    // MARK: Decoding

    func testTemplateListCarriesLyricStylesAndOlderListsStillDecode() throws {
        let list = try JSONDecoder().decode(CoreTemplateList.self, from: Data(#"{"templates":[],"lyricStyles":\#(Self.stylesJSON)}"#.utf8))
        let styles = try XCTUnwrap(list.lyricStyles)
        XCTAssertEqual(styles.first?.id, "auto")
        XCTAssertEqual(styles.first?.name.text(.japanese), "おまかせ")
        XCTAssertEqual(styles.first?.name.text(.chinese), "自动", "zh-Hans is the Chinese label")
        XCTAssertEqual(styles.first { $0.id == "noir" }?.description?.text(.english), "Black and white")
        XCTAssertTrue(styles.first { $0.id == "hrRuin" }!.isHorror)
        XCTAssertTrue(styles.first { $0.id == "sakura" }!.extra == true)
        XCTAssertEqual(styles.filter(\.isClassic).map(\.id), ["classic", "editorial", "pop", "night"])
        XCTAssertNil(try JSONDecoder().decode(CoreTemplateList.self, from: Data(#"{"templates":[]}"#.utf8)).lyricStyles)
    }

    func testLyricMetaDecodesBothEnginesLeniently() throws {
        let template = #""template":{"id":"lyrics","variant":"classic","motion":"reveal","decisionSource":"override","availableTemplates":["lyrics"]}"#
        let jizura = try JSONDecoder().decode(CoreActionMetadata.self, from: Data(#"""
        {\#(template),"lyric":{"engine":"jizura","requestedStyle":"auto","style":"noir","mood":null,"horror":false,"lang":"en","cuts":"many","lines":3,"paired":false,"families":["Noto Sans JP"],"version":"0.9.0","commit":"bae339e","prepareMs":41.5,"future":{"x":1}}}
        """#.utf8))
        let lyric = try XCTUnwrap(jizura.lyric)
        XCTAssertTrue(lyric.isJizura)
        XCTAssertEqual(lyric.requestedStyle, "auto")
        XCTAssertEqual(lyric.style, "noir")
        XCTAssertNil(lyric.mood)
        XCTAssertEqual(jizura.template?.id, "lyrics", "an odd field in meta.lyric never fails the result")

        let classic = try JSONDecoder().decode(CoreActionMetadata.self, from: Data(#"""
        {\#(template),"lyric":{"engine":"classic","reason":"fonts-missing","missing":["Noto Sans SC"],"message":"Fonts are missing.","packs":[{"id":"zh-hans","title":{"en":"Simplified Chinese lyric fonts","zh":"简体中文歌词字体","ja":"簡体字中国語の歌詞フォント"},"bytes":68869120}]}}
        """#.utf8))
        XCTAssertEqual(classic.lyric?.reason, "fonts-missing")
        XCTAssertEqual(classic.lyric?.packs?.first?.title.text(.chinese), "简体中文歌词字体", "packs key Chinese as zh")
        XCTAssertNil(try JSONDecoder().decode(CoreActionMetadata.self, from: Data("{\(template)}".utf8)).lyric)
    }

    func testFontStatusDecodesWithMissingFields() throws {
        let status = try JSONDecoder().decode(CoreFontsStatus.self, from: Data(#"""
        {"packs":[{"id":"ja","title":{"en":"Japanese lyric fonts","zh":"日文歌词字体","ja":"日本語の歌詞フォント"},"bytes":56022016,"installed":true},{"id":"ko"}]}
        """#.utf8))
        XCTAssertFalse(status.offline)
        XCTAssertEqual(status.pack("ja")?.installed, true)
        XCTAssertEqual(status.pack("ko")?.title.en, "ko")
        XCTAssertEqual(status.pack("ko")?.installing, false)
        XCTAssertNil(status.pack("ko")?.progress)
        XCTAssertNil(CoreFontProgress(done: 5, total: 0).fraction)
        XCTAssertEqual(CoreFontProgress(done: 12, total: 10).fraction, 1)
    }

    func testPackSizesAreWholeMegabytes() {
        XCTAssertEqual(FontPackSize.text(68_869_120), "69 MB")
        XCTAssertEqual(FontPackSize.text(56_022_016), "56 MB")
        XCTAssertEqual(FontPackSize.text(34_932_224), "35 MB")
        XCTAssertEqual(FontPackSize.text(120_000), "1 MB")
    }

    // MARK: Settings

    func testDefaultsAreAutoWithoutHorrorAndTheOldLyricsStyleIsNotCarriedOver() throws {
        try write(#"{"template_styles":{"lyrics":"editorial","quote":"classic"}}"#)
        let settings = try SettingsStore(directory: directory)
        XCTAssertEqual(settings.savedLyricStyle, "auto")
        XCTAssertFalse(settings.lyricHorror)
        XCTAssertEqual(settings.lyricRequest(styles: Self.styles), LyricRequest(style: "auto", horror: false))
        XCTAssertEqual(settings.renderTemplatePreferences(styles: Self.styles), ["quote": "classic"],
                       "the old lyrics entry no longer decides anything; other templates keep theirs")
        // Reading never rewrites the file.
        XCTAssertEqual(try SettingsStore(directory: directory).templatePreferences?["lyrics"], "editorial")
    }

    func testRenderPreferencesFollowTheLyricStyle() throws {
        let settings = try SettingsStore(directory: directory)
        XCTAssertNil(settings.renderTemplatePreferences(styles: Self.styles), "nothing saved, nothing sent")
        try settings.setLyricStyle("night")
        XCTAssertEqual(settings.renderTemplatePreferences(styles: Self.styles), ["lyrics": "night"], "a classic style also styles the poster")
        XCTAssertEqual(settings.renderTemplatePreferences(styles: []), ["lyrics": "night"], "known classic ids without Core's list")
        try settings.setLyricStyle("noir")
        XCTAssertNil(settings.renderTemplatePreferences(styles: Self.styles), "a JIZURA style leaves the poster to Core")
        XCTAssertEqual(try SettingsStore(directory: directory).lyricRequest(styles: Self.styles).style, "noir")
    }

    func testHorrorStylesNeedTheSwitch() throws {
        let settings = try SettingsStore(directory: directory)
        try settings.setLyricHorror(true, styles: Self.styles)
        try settings.setLyricStyle("hrRuin")
        XCTAssertEqual(settings.lyricRequest(styles: Self.styles), LyricRequest(style: "hrRuin", horror: true))
        // Turning horror off while a horror style is chosen goes back to auto.
        try settings.setLyricHorror(false, styles: Self.styles)
        XCTAssertEqual(settings.savedLyricStyle, "auto")
        XCTAssertFalse(settings.lyricHorror)
        // A horror style saved with the switch off (edited by hand) is sent as auto.
        try write(#"{"lyric_style":"hrCurse","lyric_horror":false}"#)
        XCTAssertEqual(try SettingsStore(directory: directory).lyricRequest(styles: []).style, "auto")
        // Turning horror off keeps a style that is not a horror one.
        try settings.reload()
        try settings.setLyricStyle("sakura")
        try settings.setLyricHorror(false, styles: Self.styles)
        XCTAssertEqual(settings.savedLyricStyle, "sakura")
    }

    func testAStyleCoreNoLongerListsBecomesAuto() throws {
        try write(#"{"lyric_style":"retired"}"#)
        let settings = try SettingsStore(directory: directory)
        XCTAssertEqual(settings.lyricRequest(styles: Self.styles).style, "auto")
        XCTAssertEqual(settings.lyricRequest(styles: []).style, "retired", "unchecked until Core lists its styles")
    }

    func testRestoreDefaultsResetsLyricMotion() throws {
        let settings = try SettingsStore(directory: directory)
        try settings.setLyricHorror(true, styles: Self.styles)
        try settings.setLyricStyle("editorial")
        try settings.setLyricOutput(.video)
        try settings.resetTemplates()
        let reopened = try SettingsStore(directory: directory)
        XCTAssertEqual(reopened.savedLyricStyle, "auto")
        XCTAssertFalse(reopened.lyricHorror)
        XCTAssertEqual(reopened.lyricOutput, .gif)
        XCTAssertEqual(reopened.templatePreferences, [:])
    }

    // MARK: Menus and labels

    func testMenusGroupStylesAndHideHorrorWithoutTheSwitch() {
        let off = LyricStyles.menu(Self.styles, horror: false)
        XCTAssertEqual(off.auto?.id, "auto")
        XCTAssertEqual(off.jizura.map(\.id), ["noir", "sakura"])
        XCTAssertEqual(off.classic.map(\.id), ["classic", "editorial", "pop", "night"])
        XCTAssertEqual(LyricStyles.menu(Self.styles, horror: true).jizura.map(\.id), ["noir", "sakura", "hrRuin"])
        XCTAssertEqual(off.all.first?.id, "auto")
        let poster = RenderedResult(templateID: "lyrics", variant: "classic", motion: "none", format: "png", frame: "1:1",
                                    lyric: CoreLyricMeta(engine: "classic", reason: "poster"))
        let menu = Rerender.menu(poster, styles: Self.styles, horror: true)
        XCTAssertNil(menu.auto, "a poster is always classic")
        XCTAssertEqual(menu.jizura, [])
        XCTAssertEqual(menu.classic.count, 4)
    }

    func testStyleLabels() {
        let styles = Self.styles
        let auto = jizuraResult(requested: "auto", style: "noir")
        XCTAssertEqual(Rerender.styleLabel(auto, styles: styles, fallback: "auto", language: .english), "Auto (Noir)")
        XCTAssertEqual(Rerender.styleLabel(auto, styles: styles, fallback: "auto", language: .japanese), "おまかせ（ノワール）")
        XCTAssertEqual(Rerender.styleLabel(jizuraResult(requested: "sakura", style: "sakura"), styles: styles, fallback: "auto", language: .chinese), "樱")
        XCTAssertEqual(Rerender.styleLabel(fallbackResult(), styles: styles, fallback: "auto", language: .english), "Auto (Stage)",
                       "the classic style that stood in for what was asked")
        let chosen = RenderedResult(templateID: "lyrics", variant: "editorial", motion: "reveal", format: "gif", frame: "1:1",
                                    lyric: CoreLyricMeta(engine: "classic", reason: "chosen"), lyricRequest: LyricRequest(style: "editorial", horror: false))
        XCTAssertEqual(Rerender.styleLabel(chosen, styles: styles, fallback: "auto", language: .english), "Paper")
        XCTAssertEqual(LyricStyles.name("unknown", in: styles, language: .english), "unknown")
    }

    // MARK: Rerendering

    private func jizuraResult(requested: String, style: String, format: String = "gif", horror: Bool = false) -> RenderedResult {
        RenderedResult(templateID: "lyrics", variant: "classic", motion: "reveal", format: format, frame: "16:9",
                       lyric: CoreLyricMeta(engine: "jizura", requestedStyle: requested, style: style, horror: horror, lang: "en"),
                       lyricRequest: LyricRequest(style: requested, horror: horror))
    }
    private func fallbackResult(reason: String = "fonts-missing") -> RenderedResult {
        RenderedResult(templateID: "lyrics", variant: "classic", motion: "reveal", format: "gif", frame: "1:1",
                       lyric: CoreLyricMeta(engine: "classic", reason: reason, missing: ["Noto Sans SC"]),
                       lyricRequest: LyricRequest(style: "auto", horror: false))
    }
    private func plan(_ result: RenderedResult, _ change: RerenderChange, defaults: LyricRequest = LyricRequest(style: "pop", horror: false)) -> RerenderPlan {
        Rerender.plan(result, change: change, savedFrame: { $0 == "image" ? "auto" : "4:5" }, lyricDefaults: defaults, styles: Self.styles)
    }

    /// The bug: a format or frame change of a JIZURA film sent the result's
    /// variant, which Core reads as a classic choice, and redrew it in Stage.
    func testFormatAndFrameChangesKeepJizuraAndItsStyle() {
        let result = jizuraResult(requested: "auto", style: "noir")
        let video = plan(result, RerenderChange(format: "mp4"))
        XCTAssertEqual(video.actionID, "paste-video")
        XCTAssertEqual(video.options, CoreTemplateOptions(id: "lyrics"), "no variant, no motion: JIZURA has its own")
        XCTAssertEqual(video.lyric, LyricRequest(style: "auto", horror: false), "the requested style, not the resolved one")
        XCTAssertEqual(video.frame, "4:5", "a new kind takes its saved frame")
        let square = plan(result, RerenderChange(frame: "1:1"))
        XCTAssertEqual(square.actionID, "paste-gif")
        XCTAssertEqual(square.frame, "1:1")
        XCTAssertNil(square.options.variant)
        XCTAssertEqual(square.lyric?.style, "auto")
        XCTAssertNil(square.rememberLyricStyle)
        XCTAssertFalse(square.rememberVariant)
        let horror = plan(jizuraResult(requested: "hrRuin", style: "hrRuin", horror: true), RerenderChange(format: "mp4"))
        XCTAssertEqual(horror.lyric, LyricRequest(style: "hrRuin", horror: true), "a horror film keeps its switch")
    }

    func testPickingAStyleRedrawsWithItAndRemembersIt() {
        let result = jizuraResult(requested: "auto", style: "noir")
        let jizura = plan(result, RerenderChange(lyricStyle: "sakura"))
        XCTAssertEqual(jizura.options, CoreTemplateOptions(id: "lyrics"))
        XCTAssertEqual(jizura.lyric, LyricRequest(style: "sakura", horror: false))
        XCTAssertEqual(jizura.rememberLyricStyle, "sakura")
        XCTAssertFalse(jizura.rememberVariant, "not template_styles")
        let classic = plan(result, RerenderChange(lyricStyle: "editorial"))
        XCTAssertEqual(classic.options.variant, "editorial", "a classic style is Core's classic choice")
        XCTAssertEqual(classic.lyric?.style, "editorial")
        XCTAssertEqual(classic.rememberLyricStyle, "editorial")
        let horror = plan(result, RerenderChange(lyricStyle: "hrRuin"))
        XCTAssertEqual(horror.lyric, LyricRequest(style: "hrRuin", horror: true))
        let poster = plan(RenderedResult(templateID: "lyrics", variant: "classic", motion: "none", format: "png", frame: "auto",
                                         lyric: CoreLyricMeta(engine: "classic", reason: "poster"), lyricRequest: LyricRequest(style: "auto", horror: false)),
                          RerenderChange(lyricStyle: "night"))
        XCTAssertEqual(poster.actionID, "paste-card")
        XCTAssertEqual(poster.options.variant, "night", "the poster is drawn in it")
    }

    func testClassicResultsKeepTodaysBehaviour() {
        let chosen = RenderedResult(templateID: "lyrics", variant: "editorial", motion: "typewriter", format: "gif", frame: "1:1",
                                    lyric: CoreLyricMeta(engine: "classic", reason: "chosen"), lyricRequest: LyricRequest(style: "editorial", horror: false))
        let video = plan(chosen, RerenderChange(format: "mp4"))
        XCTAssertEqual(video.options, CoreTemplateOptions(id: "lyrics", variant: "editorial", motion: "typewriter"))
        XCTAssertEqual(video.lyric?.style, "editorial")
        let motion = plan(chosen, RerenderChange(motion: "reveal"))
        XCTAssertEqual(motion.options.motion, "reveal")
        XCTAssertEqual(motion.options.variant, "editorial")
    }

    /// A classic stand-in asks for what was asked before, so Redraw (no change)
    /// goes to JIZURA once the fonts are in, and a format change keeps the note.
    func testFallbackResultsAskForTheRequestedStyleAgain() {
        let redraw = plan(fallbackResult(), RerenderChange())
        XCTAssertEqual(redraw.actionID, "paste-gif")
        XCTAssertNil(redraw.options.variant)
        XCTAssertEqual(redraw.options.motion, "reveal")
        XCTAssertEqual(redraw.lyric, LyricRequest(style: "auto", horror: false))
        XCTAssertEqual(redraw.frame, "1:1")
        // Unknown request (e.g. an older result): the saved style.
        let unknown = RenderedResult(templateID: "lyrics", variant: "classic", motion: "reveal", format: "gif", frame: "1:1",
                                     lyric: CoreLyricMeta(engine: "classic", reason: "glyphs"))
        XCTAssertEqual(plan(unknown, RerenderChange(format: "mp4")).lyric?.style, "pop")
        // From a poster to a GIF: the style the poster was asked with, so a
        // JIZURA film made a poster and back is JIZURA's again.
        let poster = RenderedResult(templateID: "lyrics", variant: "classic", motion: "none", format: "png", frame: "auto",
                                    lyric: CoreLyricMeta(engine: "classic", reason: "poster"), lyricRequest: LyricRequest(style: "auto", horror: false))
        let gif = plan(poster, RerenderChange(format: "gif"))
        XCTAssertEqual(gif.lyric?.style, "auto")
        XCTAssertNil(gif.options.variant)
        XCTAssertNil(gif.options.motion, "from a poster, motion is Core's choice")
        XCTAssertEqual(gif.frame, "4:5", "a new kind takes its saved frame")
        XCTAssertEqual(Rerender.checkedStyle(poster, fallback: "pop"), "classic", "its menu checks the style it is drawn in")
        XCTAssertEqual(Rerender.styleLabel(poster, styles: Self.styles, fallback: "pop", language: .english), "Stage")
        let classicPoster = RenderedResult(templateID: "lyrics", variant: "night", motion: "none", format: "png", frame: "auto",
                                           lyric: CoreLyricMeta(engine: "classic", reason: "poster"), lyricRequest: LyricRequest(style: "night", horror: false))
        XCTAssertEqual(plan(classicPoster, RerenderChange(format: "mp4")).options.variant, "night")
        // Round trip: JIZURA GIF → poster → GIF asks for the same style all the way.
        let film = jizuraResult(requested: "sakura", style: "sakura")
        let toPoster = plan(film, RerenderChange(format: "png"))
        XCTAssertEqual(toPoster.lyric?.style, "sakura")
        XCTAssertNil(toPoster.options.variant)
        let drawn = RenderedResult(templateID: "lyrics", variant: "classic", motion: "none", format: "png", frame: toPoster.frame,
                                   lyric: CoreLyricMeta(engine: "classic", reason: "poster"), lyricRequest: toPoster.lyric)
        XCTAssertEqual(plan(drawn, RerenderChange(format: "gif")).lyric?.style, "sakura")
    }

    func testOtherTemplatesAndSwitchingIntoLyrics() {
        let quote = RenderedResult(templateID: "quote", variant: "classic", motion: "reveal", format: "gif", frame: "16:9")
        let restyled = plan(quote, RerenderChange(variant: "editorial"))
        XCTAssertEqual(restyled.options, CoreTemplateOptions(id: "quote", variant: "editorial", motion: "reveal"))
        XCTAssertTrue(restyled.rememberVariant)
        XCTAssertNil(restyled.lyric)
        XCTAssertEqual(restyled.frame, "16:9")
        let toText = plan(quote, RerenderChange(templateID: "text"))
        XCTAssertEqual(toText.options, CoreTemplateOptions(id: "text"))
        XCTAssertNil(toText.lyric)
        let toLyrics = plan(quote, RerenderChange(templateID: "lyrics"), defaults: LyricRequest(style: "noir", horror: false))
        XCTAssertEqual(toLyrics.options, CoreTemplateOptions(id: "lyrics"))
        XCTAssertEqual(toLyrics.lyric, LyricRequest(style: "noir", horror: false), "as paste-lyric would draw it")
        let png = plan(RenderedResult(templateID: "quote", variant: "classic", motion: "none", format: "png", frame: "auto"), RerenderChange(format: "gif"))
        XCTAssertEqual(png.actionID, "paste-gif")
        XCTAssertNil(png.options.motion)
        XCTAssertEqual(png.frame, "4:5")
    }

    // MARK: Fallback notes

    func testFallbackKinds() {
        XCTAssertNil(LyricFallback.of(nil))
        XCTAssertNil(LyricFallback.of(CoreLyricMeta(engine: "jizura", requestedStyle: "auto", style: "noir")))
        XCTAssertNil(LyricFallback.of(CoreLyricMeta(engine: "classic", reason: "poster")))
        XCTAssertNil(LyricFallback.of(CoreLyricMeta(engine: "classic", reason: "chosen")))
        XCTAssertEqual(LyricFallback.of(CoreLyricMeta(engine: "classic", reason: "engine", message: "no addon")), .engine)
        XCTAssertEqual(LyricFallback.of(CoreLyricMeta(engine: "classic", reason: "glyphs", characters: ["♪"])), .glyphs(["♪"]))
        let pack = CoreLyricPack(id: "zh-hans", title: CoreLabels(en: "Simplified Chinese lyric fonts", zh: "简体中文歌词字体", ja: "簡体字中国語の歌詞フォント"), bytes: 68_869_120)
        XCTAssertEqual(LyricFallback.of(CoreLyricMeta(engine: "classic", reason: "fonts-missing", missing: ["Noto Sans SC"], packs: [pack])), .fontsMissing([pack]))
        // Without `packs` (an older Core): the status names them by family.
        let status = CoreFontsStatus(offline: false, packs: [
            CoreFontPack(id: "base", title: CoreLabels(en: "Base"), bytes: 1, installed: true, bundled: true, families: ["Noto Sans JP"]),
            CoreFontPack(id: "zh-hans", title: pack.title, bytes: pack.bytes, families: ["Noto Sans SC", "Noto Serif SC"]),
            CoreFontPack(id: "ko", title: CoreLabels(en: "Korean lyric fonts"), bytes: 34_932_224, families: ["Noto Sans KR"]),
        ])
        XCTAssertEqual(LyricFallback.of(CoreLyricMeta(engine: "classic", reason: "fonts-missing", missing: ["Noto Sans SC"]), status: status), .fontsMissing([pack]))
        XCTAssertEqual(LyricFallback.of(CoreLyricMeta(engine: "classic", reason: "fonts-missing", missing: ["Noto Sans SC"])), .fontsMissing([]))
    }

    func testFallbackMessagesNameThePacksAndSizes() {
        let zh = CoreLyricPack(id: "zh-hans", title: CoreLabels(en: "Simplified Chinese lyric fonts", zh: "简体中文歌词字体", ja: "簡体字中国語の歌詞フォント"), bytes: 68_869_120)
        let ko = CoreLyricPack(id: "ko", title: CoreLabels(en: "Korean lyric fonts", zh: "韩文歌词字体", ja: "韓国語の歌詞フォント"), bytes: 34_932_224)
        let en = Localizer(.english), ja = Localizer(.japanese), cn = Localizer(.chinese)
        XCTAssertEqual(LyricFallback.fontsMissing([zh]).message(en), "Drawn in the classic style: JIZURA needs the Simplified Chinese lyric fonts (69 MB).")
        XCTAssertEqual(LyricFallback.fontsMissing([zh]).bubble(en),
                       "Drawn in the classic style: JIZURA needs the Simplified Chinese lyric fonts (69 MB). Download them in clipboard history or Settings › Templates.")
        XCTAssertEqual(LyricFallback.fontsMissing([zh, ko]).message(en), "Drawn in the classic style: JIZURA needs the Simplified Chinese lyric fonts and Korean lyric fonts (104 MB).")
        XCTAssertEqual(LyricFallback.fontsMissing([zh]).message(cn), "已用经典风格绘制：JIZURA 需要简体中文歌词字体（69 MB）。")
        XCTAssertTrue(LyricFallback.fontsMissing([zh, ko]).message(ja).contains("簡体字中国語の歌詞フォント、韓国語の歌詞フォント（104 MB）"))
        XCTAssertFalse(LyricFallback.fontsMissing([zh]).bubble(ja).contains("Download"), "Japanese from the table")
        XCTAssertEqual(LyricFallback.glyphs(["★", "♪", "※", "‥", "〒", "☆"]).message(en).replacingOccurrences(of: "\u{00A0}", with: "_"),
                       "Drawn in the classic style: JIZURA's fonts have no ★_♪_※_‥_〒_….", "five at most, never broken across lines")
        XCTAssertTrue(LyricFallback.glyphs(["\u{200B}"]).message(en).contains("U+200B"))
        XCTAssertEqual(LyricFallback.engine.bubble(en), "JIZURA could not start, so the classic style was used.")
        XCTAssertEqual(LyricFallback.glyphs([]).bubble(ja), "クラシックスタイルで描きました。JIZURA のフォントには、このテキストの一部の文字がありません。")
    }

    /// Korean without its pack: neither JIZURA nor the classic style draws it, so the action fails and names the pack.
    func testUnsupportedScriptMessagesNameThePack() {
        let ko = CoreLyricPack(id: "ko", title: CoreLabels(en: "Korean lyric fonts", zh: "韩文歌词字体", ja: "韓国語の歌詞フォント"), bytes: 34_932_224)
        let en = Localizer(.english), ja = Localizer(.japanese), cn = Localizer(.chinese)
        XCTAssertEqual(LyricFallback.unsupportedMessage([ko], en),
                       "Nothing was made: this text needs JIZURA's Korean lyric fonts (35 MB); the classic style cannot draw it.")
        XCTAssertEqual(LyricFallback.unsupportedBubble([ko], en),
                       "Nothing was made: this text needs JIZURA's Korean lyric fonts (35 MB); the classic style cannot draw it. Download them in clipboard history or Settings › Templates.")
        XCTAssertEqual(LyricFallback.unsupportedMessage([ko], cn), "未生成：这段文字需要 JIZURA 的韩文歌词字体（35 MB），经典风格无法绘制。")
        XCTAssertTrue(LyricFallback.unsupportedBubble([ko], ja).hasSuffix("クリップボード履歴か「設定 › テンプレート」でダウンロードできます。"))
        XCTAssertTrue(LyricFallback.unsupportedBubble([ko], ja).contains("韓国語の歌詞フォント（35 MB）"))
    }

    // MARK: Font pack requests

    private func status(_ packs: [CoreFontPack], offline: Bool = false) -> CoreFontsStatus { CoreFontsStatus(offline: offline, packs: packs) }
    private func pack(_ id: String, installed: Bool = false, installing: Bool = false, error: CoreFontPackError? = nil) -> CoreFontPack {
        CoreFontPack(id: id, title: CoreLabels(en: id), bytes: 1_000_000, installed: installed, installing: installing,
                     progress: installing ? CoreFontProgress(done: 1, total: 2) : nil, error: error)
    }

    func testARequestIsSentThenFollowedToTheEnd() {
        var requests = FontPackRequests()
        XCTAssertFalse(requests.isActive)
        requests.request("zh-hans")
        requests.request("zh-hans")
        XCTAssertEqual(requests.requested, ["zh-hans"])
        XCTAssertEqual(requests.reconcile(status([pack("zh-hans")])).install, ["zh-hans"])
        XCTAssertEqual(requests.reconcile(status([pack("zh-hans", installing: true)])), .init())
        XCTAssertTrue(requests.contains("zh-hans"))
        XCTAssertEqual(requests.reconcile(status([pack("zh-hans", installed: true)])).finished, ["zh-hans"])
        XCTAssertFalse(requests.isActive)
    }

    /// Core restarted mid-download: it forgot the download (no error, not
    /// running), so the app asks again and Core resumes the partial file.
    func testADownloadCoreForgotIsAskedForAgain() {
        var requests = FontPackRequests()
        requests.request("ja")
        _ = requests.reconcile(status([pack("ja")]))
        _ = requests.reconcile(status([pack("ja", installing: true)]))
        for _ in 0..<5 {
            // Each restart is followed by a running download, so it never gives up.
            XCTAssertEqual(requests.reconcile(status([pack("ja")])).install, ["ja"])
            _ = requests.reconcile(status([pack("ja", installing: true)]))
        }
        XCTAssertTrue(requests.isActive)
    }

    func testAskingTooOftenWithoutADownloadRunningFails() {
        var requests = FontPackRequests()
        requests.request("ko")
        for _ in 0..<FontPackRequests.maxAttempts { XCTAssertEqual(requests.reconcile(status([pack("ko")])).install, ["ko"]) }
        XCTAssertEqual(requests.reconcile(status([pack("ko")])).failed, [.init(id: "ko", code: "not-started")])
        XCTAssertFalse(requests.isActive)
    }

    func testErrorsCountOnlyAfterThisRequestWasSent() {
        let network = CoreFontPackError(code: "network", message: "connection reset")
        var requests = FontPackRequests()
        requests.request("ko")
        // An error left from an earlier try: ask again.
        XCTAssertEqual(requests.reconcile(status([pack("ko", error: network)])).install, ["ko"])
        // While it runs, a stale error is ignored.
        XCTAssertEqual(requests.reconcile(status([pack("ko", installing: true, error: network)])), .init())
        let step = requests.reconcile(status([pack("ko", error: CoreFontPackError(code: "checksum", message: "bad sum"))]))
        XCTAssertEqual(step.failed, [.init(id: "ko", code: "checksum", message: "bad sum")])
        XCTAssertEqual(step.install, [])
        XCTAssertFalse(requests.isActive)
    }

    func testOfflineUnknownAndDroppedPacks() {
        var requests = FontPackRequests()
        requests.request("ja"); requests.request("xx"); requests.request("ko")
        requests.drop("ko")
        let step = requests.reconcile(status([pack("ja")], offline: true))
        XCTAssertEqual(step.failed.map(\.code), ["offline", "unknown-pack"])
        XCTAssertEqual(step.install, [], "never asks while offline")
        XCTAssertFalse(requests.isActive)
    }

    func testPollingOnlyWhileSomethingIsHappening() {
        XCTAssertTrue(FontPackPolling.shouldPoll(requested: true, installing: false, visible: false), "the user's own download")
        XCTAssertTrue(FontPackPolling.shouldPoll(requested: false, installing: true, visible: true))
        XCTAssertFalse(FontPackPolling.shouldPoll(requested: false, installing: true, visible: false), "nobody is looking")
        XCTAssertFalse(FontPackPolling.shouldPoll(requested: false, installing: false, visible: true), "nothing is running")
    }
}
