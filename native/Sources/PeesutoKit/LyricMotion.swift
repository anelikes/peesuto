import Foundation

// Lyric motion (template `lyrics`, action paste-lyric): its styles, the
// settings that choose one, how a result is rerendered, and what the app
// says when JIZURA could not draw a film. Core decides the engine
// (core/src/templates/lyrics-route.ts); this side only chooses and reports.

// MARK: - Core models

/// Text Core sends in the three UI languages. Lyric styles key Chinese as
/// "zh-Hans", font packs as "zh"; either is read. A missing language falls
/// back to English.
public struct CoreLabels: Codable, Equatable, Sendable {
    public let en: String
    public let zh: String?
    public let ja: String?

    public init(en: String, zh: String? = nil, ja: String? = nil) { self.en = en; self.zh = zh; self.ja = ja }

    private enum Keys: String, CodingKey { case en, zh, ja, zhHans = "zh-Hans" }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let zh = ((try? c.decodeIfPresent(String.self, forKey: .zhHans)) ?? nil) ?? ((try? c.decodeIfPresent(String.self, forKey: .zh)) ?? nil)
        let ja = (try? c.decodeIfPresent(String.self, forKey: .ja)) ?? nil
        en = ((try? c.decodeIfPresent(String.self, forKey: .en)) ?? nil) ?? ja ?? zh ?? ""
        self.zh = zh; self.ja = ja
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(en, forKey: .en)
        try c.encodeIfPresent(zh, forKey: .zh)
        try c.encodeIfPresent(ja, forKey: .ja)
    }

    public func text(_ language: UILanguage) -> String {
        switch language {
        case .english: return en
        case .chinese: return zh ?? en
        case .japanese: return ja ?? en
        }
    }
}

/// One of Lyric motion's styles as `templates.list` reports it (`lyricStyles`).
public struct CoreLyricStyle: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    /// "jizura" or "classic" (Pocket Motion).
    public let engine: String
    public let name: CoreLabels
    public let description: CoreLabels?
    public let horror: Bool?
    /// JIZURA's 追加分: added after its first release.
    public let extra: Bool?

    public init(id: String, engine: String, name: CoreLabels, description: CoreLabels? = nil, horror: Bool? = nil, extra: Bool? = nil) {
        self.id = id; self.engine = engine; self.name = name; self.description = description; self.horror = horror; self.extra = extra
    }

    public var isClassic: Bool { engine == "classic" }
    public var isHorror: Bool { horror == true }
}

/// A downloadable font pack as a Lyric motion result names it.
public struct CoreLyricPack: Codable, Equatable, Sendable {
    public let id: String
    public let title: CoreLabels
    public let bytes: Double

    public init(id: String, title: CoreLabels, bytes: Double) { self.id = id; self.title = title; self.bytes = bytes }
}

/// `meta.lyric` of a Lyric motion result: drawn by JIZURA (with the style
/// asked for and the one it became), or classic with the reason. Decoded
/// leniently: a field this version does not understand never fails the result.
public struct CoreLyricMeta: Codable, Equatable, Sendable {
    /// "jizura" or "classic".
    public let engine: String
    // Drawn by JIZURA
    public let requestedStyle: String?
    public let style: String?
    public let mood: String?
    public let horror: Bool?
    public let lang: String?
    // Classic
    /// "poster", "chosen", "fonts-missing", "glyphs" or "engine".
    public let reason: String?
    /// fonts-missing: the families that are not on this Mac.
    public let missing: [String]?
    /// glyphs: characters none of JIZURA's faces has.
    public let characters: [String]?
    public let message: String?
    /// fonts-missing: the packs that would let JIZURA draw it.
    public let packs: [CoreLyricPack]?

    public init(engine: String, requestedStyle: String? = nil, style: String? = nil, mood: String? = nil, horror: Bool? = nil,
                lang: String? = nil, reason: String? = nil, missing: [String]? = nil, characters: [String]? = nil,
                message: String? = nil, packs: [CoreLyricPack]? = nil) {
        self.engine = engine; self.requestedStyle = requestedStyle; self.style = style; self.mood = mood; self.horror = horror
        self.lang = lang; self.reason = reason; self.missing = missing; self.characters = characters; self.message = message; self.packs = packs
    }

    private enum Keys: String, CodingKey { case engine, requestedStyle, style, mood, horror, lang, reason, missing, characters, message, packs }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        func value<T: Decodable>(_ key: Keys) -> T? { (try? c.decodeIfPresent(T.self, forKey: key)) ?? nil }
        engine = value(.engine) ?? ""
        requestedStyle = value(.requestedStyle); style = value(.style); mood = value(.mood)
        horror = value(.horror); lang = value(.lang); reason = value(.reason)
        missing = value(.missing); characters = value(.characters); message = value(.message)
        packs = value(.packs)
    }

    public var isJizura: Bool { engine == "jizura" }
    public var isClassic: Bool { engine == "classic" }
}

// MARK: - Styles and settings

/// What a Lyric motion render asks Core for (`lyricStyle`, `lyricHorror`).
public struct LyricRequest: Equatable, Sendable {
    public let style: String
    public let horror: Bool
    public init(style: String, horror: Bool) { self.style = style; self.horror = horror }
}

/// Lyric motion's styles as the menus show them.
public enum LyricStyles {
    public static let templateID = "lyrics"
    /// JIZURA's おまかせ: it picks a style and a mood from the text.
    public static let auto = "auto"
    /// The classic (Pocket Motion) style ids, for when Core has not listed the styles.
    public static let classicIDs = ["classic", "editorial", "pop", "night"]
    /// JIZURA's horror styles at the pinned version, for the same case.
    public static let horrorIDs = ["hrRuin", "hrNightRec", "hrCurse"]

    public static func isClassic(_ id: String, in styles: [CoreLyricStyle]) -> Bool {
        styles.first { $0.id == id }.map(\.isClassic) ?? classicIDs.contains(id)
    }
    public static func isHorror(_ id: String, in styles: [CoreLyricStyle]) -> Bool {
        styles.first { $0.id == id }.map(\.isHorror) ?? horrorIDs.contains(id)
    }
    /// Whether Core would take `id`: always when the list is unknown.
    public static func isKnown(_ id: String, in styles: [CoreLyricStyle]) -> Bool {
        id == auto || styles.isEmpty || styles.contains { $0.id == id }
    }

    /// Auto, JIZURA's styles (horror ones only with `horror`), the classic ones.
    public struct Menu: Equatable, Sendable {
        public let auto: CoreLyricStyle?
        public let jizura: [CoreLyricStyle]
        public let classic: [CoreLyricStyle]
        public var all: [CoreLyricStyle] { (auto.map { [$0] } ?? []) + jizura + classic }
    }

    public static func menu(_ styles: [CoreLyricStyle], horror: Bool) -> Menu {
        Menu(auto: styles.first { $0.id == auto },
             jizura: styles.filter { $0.id != auto && !$0.isClassic && (horror || !$0.isHorror) },
             classic: styles.filter(\.isClassic))
    }

    /// A style's name in the UI language; the id itself when Core has not named it.
    public static func name(_ id: String, in styles: [CoreLyricStyle], language: UILanguage) -> String {
        styles.first { $0.id == id }?.name.text(language) ?? id
    }

    /// "Auto (Noir)": a style as asked for, with what it became when that differs.
    public static func label(_ requested: String, becoming resolved: String?, in styles: [CoreLyricStyle], language: UILanguage) -> String {
        let name = self.name(requested, in: styles, language: language)
        guard let resolved, resolved != requested else { return name }
        let other = self.name(resolved, in: styles, language: language)
        return language == .english ? "\(name) (\(other))" : "\(name)（\(other)）"
    }
}

extension SettingsStore {
    /// settings.json: Lyric motion's style (default "auto") and JIZURA's horror switch (default off).
    public static let lyricStyleKey = "lyric_style"
    public static let lyricHorrorKey = "lyric_horror"

    /// The style as saved; "auto" when none was. The older `template_styles["lyrics"]`
    /// is not carried over: everyone starts on Auto.
    public var savedLyricStyle: String {
        let value = (values[Self.lyricStyleKey] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
        return value.isEmpty ? LyricStyles.auto : value
    }
    public var lyricHorror: Bool { bool(Self.lyricHorrorKey) }

    /// What paste-lyric sends: the saved style, or auto when it is a horror style
    /// with the switch off, or one Core does not list (any more).
    public func lyricRequest(styles: [CoreLyricStyle]) -> LyricRequest {
        let horror = lyricHorror
        var style = savedLyricStyle
        if !horror && LyricStyles.isHorror(style, in: styles) { style = LyricStyles.auto }
        if !LyricStyles.isKnown(style, in: styles) { style = LyricStyles.auto }
        return LyricRequest(style: style, horror: horror)
    }

    public func setLyricStyle(_ id: String) throws {
        try set(Self.lyricStyleKey, value: id.isEmpty ? LyricStyles.auto : id)
    }

    /// Turning horror off while a horror style is chosen goes back to auto.
    public func setLyricHorror(_ on: Bool, styles: [CoreLyricStyle]) throws {
        var updates: [String: Any] = [Self.lyricHorrorKey: on]
        if !on, LyricStyles.isHorror(savedLyricStyle, in: styles) { updates[Self.lyricStyleKey] = LyricStyles.auto }
        try setValues(updates)
    }

    /// The template styles every render sends (`templatePreferences`). Lyric
    /// motion's entry follows `lyric_style`: a classic style also styles the
    /// poster; otherwise the poster keeps Core's default. The old
    /// `template_styles["lyrics"]` no longer decides anything.
    public func renderTemplatePreferences(styles: [CoreLyricStyle]) -> [String: String]? {
        let saved = templatePreferences
        var preferences = saved ?? [:]
        preferences[LyricStyles.templateID] = nil
        let style = lyricRequest(styles: styles).style
        if LyricStyles.isClassic(style, in: styles) { preferences[LyricStyles.templateID] = style }
        return saved == nil && preferences.isEmpty ? nil : preferences
    }
}

// MARK: - Rerendering a result

/// A result as its template menus see it.
public struct RenderedResult: Sendable {
    public let templateID: String
    public let variant: String
    public let motion: String
    /// "png", "gif" or "mp4".
    public let format: String?
    /// The frame this result used.
    public let frame: String?
    public let lyric: CoreLyricMeta?
    /// What this result was asked for (Lyric motion renders only).
    public let lyricRequest: LyricRequest?

    public init(templateID: String, variant: String, motion: String, format: String?, frame: String?,
                lyric: CoreLyricMeta? = nil, lyricRequest: LyricRequest? = nil) {
        self.templateID = templateID; self.variant = variant; self.motion = motion; self.format = format
        self.frame = frame; self.lyric = lyric; self.lyricRequest = lyricRequest
    }

    public var isLyrics: Bool { templateID == LyricStyles.templateID }
    /// Drawn by JIZURA: it has its own motion.
    public var isJizura: Bool { isLyrics && lyric?.isJizura == true }
    public var isPoster: Bool { (format ?? "png") == "png" }
}

/// One change picked from a result's menus.
public struct RerenderChange: Equatable, Sendable {
    public var templateID: String?
    public var variant: String?
    public var motion: String?
    public var format: String?
    public var frame: String?
    /// Lyric motion: a style from its style menu.
    public var lyricStyle: String?
    public init(templateID: String? = nil, variant: String? = nil, motion: String? = nil, format: String? = nil,
                frame: String? = nil, lyricStyle: String? = nil) {
        self.templateID = templateID; self.variant = variant; self.motion = motion; self.format = format
        self.frame = frame; self.lyricStyle = lyricStyle
    }
}

/// The request a change makes, and what it remembers once it succeeds.
public struct RerenderPlan: Equatable, Sendable {
    public let actionID: String
    public let options: CoreTemplateOptions
    public let frame: String
    /// Lyric motion's style and horror switch; nil for other templates.
    public let lyric: LyricRequest?
    /// Save the result's variant as its template's style (`template_styles`).
    public let rememberVariant: Bool
    /// Save this as Lyric motion's style (`lyric_style`).
    public let rememberLyricStyle: String?
}

public enum Rerender {
    public static func actionID(format: String) -> String {
        format == "mp4" ? "paste-video" : format == "gif" ? "paste-gif" : "paste-card"
    }

    /// `savedFrame` is the default frame for "image", "gif" or "video";
    /// `lyricDefaults` what paste-lyric would send now (Settings).
    public static func plan(_ result: RenderedResult, change: RerenderChange, savedFrame: (String) -> String,
                            lyricDefaults: LyricRequest, styles: [CoreLyricStyle]) -> RerenderPlan {
        let format = change.format ?? result.format ?? "png"
        let kind = OutputFrames.kind(output: format) ?? "image"
        // Same kind keeps this result's frame; a new kind takes its saved default.
        let sameKind = OutputFrames.kind(output: result.format) == kind
        let frame = change.frame.map { OutputFrames.normalize($0, kind: kind) }
            ?? (sameKind ? result.frame.map { OutputFrames.normalize($0, kind: kind) } : nil)
            ?? savedFrame(kind)
        let template = change.templateID ?? result.templateID
        let changingTemplate = change.templateID != nil && change.templateID != result.templateID
        let motion = change.motion ?? (changingTemplate || (change.format != nil && result.format == "png") ? nil : result.motion)
        let action = actionID(format: format)

        guard template == LyricStyles.templateID else {
            let options = CoreTemplateOptions(id: template, variant: change.variant ?? (changingTemplate ? nil : result.variant), motion: motion)
            return RerenderPlan(actionID: action, options: options, frame: frame, lyric: nil,
                                rememberVariant: change.variant != nil, rememberLyricStyle: nil)
        }
        if changingTemplate {
            // Into Lyric motion from another template: as paste-lyric would draw it.
            return RerenderPlan(actionID: action, options: CoreTemplateOptions(id: template), frame: frame,
                                lyric: lyricDefaults, rememberVariant: false, rememberLyricStyle: nil)
        }
        let lyric: LyricRequest
        if let picked = change.lyricStyle {
            lyric = LyricRequest(style: picked, horror: LyricStyles.isHorror(picked, in: styles) || lyricDefaults.horror)
        } else {
            // Format, frame or motion: the same style again (a JIZURA film stays JIZURA's).
            lyric = LyricRequest(style: currentStyle(result, fallback: lyricDefaults.style),
                                 horror: result.lyric?.horror ?? result.lyricRequest?.horror ?? lyricDefaults.horror)
        }
        // A classic style goes as the variant too, so the poster is drawn in it; a
        // variant is Core's sign of a classic choice, so JIZURA's styles send none.
        let variant = LyricStyles.isClassic(lyric.style, in: styles) ? lyric.style : nil
        return RerenderPlan(actionID: action, options: CoreTemplateOptions(id: template, variant: variant, motion: result.isJizura ? nil : motion),
                            frame: frame, lyric: lyric, rememberVariant: false, rememberLyricStyle: change.lyricStyle)
    }

    /// The style a Lyric motion result asks for again (a format, frame or
    /// motion change, Redraw): JIZURA's requested style; a chosen classic style;
    /// for a poster or a classic stand-in, the style it was asked with (so a
    /// JIZURA film made a poster and back is JIZURA's again). `fallback` (the
    /// saved style) when that is not known.
    public static func currentStyle(_ result: RenderedResult, fallback: String) -> String {
        guard let lyric = result.lyric else { return result.lyricRequest?.style ?? result.variant }
        if lyric.isJizura { return lyric.requestedStyle ?? result.lyricRequest?.style ?? LyricStyles.auto }
        switch lyric.reason {
        case "chosen", nil: return result.variant
        case "poster": return result.lyricRequest?.style ?? result.variant
        default: return result.lyricRequest?.style ?? fallback
        }
    }

    /// The style checked in the result's style menu: what it asks for, but for
    /// a poster the classic style it is drawn in.
    public static func checkedStyle(_ result: RenderedResult, fallback: String) -> String {
        result.isPoster ? result.variant : currentStyle(result, fallback: fallback)
    }

    /// Where a lyric result's style menu starts. A poster is always classic, so
    /// its menu lists only the classic styles.
    public static func menu(_ result: RenderedResult, styles: [CoreLyricStyle], horror: Bool) -> LyricStyles.Menu {
        let menu = LyricStyles.menu(styles, horror: horror)
        return result.isPoster ? LyricStyles.Menu(auto: nil, jizura: [], classic: menu.classic) : menu
    }

    /// The style menu's title: "Auto (Noir)" for JIZURA's pick, "Auto (Stage)"
    /// when the classic style stood in, else the style's name (a poster: its classic style).
    public static func styleLabel(_ result: RenderedResult, styles: [CoreLyricStyle], fallback: String, language: UILanguage) -> String {
        if result.isPoster { return LyricStyles.name(result.variant, in: styles, language: language) }
        let current = currentStyle(result, fallback: fallback)
        if let lyric = result.lyric, lyric.isJizura {
            return LyricStyles.label(current, becoming: current == LyricStyles.auto ? lyric.style : nil, in: styles, language: language)
        }
        return LyricStyles.label(current, becoming: result.variant, in: styles, language: language)
    }
}

// MARK: - When JIZURA could not draw it

/// A GIF or video that the classic renderer drew instead of JIZURA, and why.
/// The poster and a chosen classic style are not fallbacks.
public enum LyricFallback: Equatable, Sendable {
    /// JIZURA needs these packs (empty when Core could not say which).
    case fontsMissing([CoreLyricPack])
    /// Characters none of JIZURA's faces has.
    case glyphs([String])
    /// JIZURA did not start.
    case engine

    /// `status` names the packs when the result does not.
    public static func of(_ meta: CoreLyricMeta?, status: CoreFontsStatus? = nil) -> LyricFallback? {
        guard let meta, meta.isClassic else { return nil }
        switch meta.reason {
        case "fonts-missing":
            if let packs = meta.packs, !packs.isEmpty { return .fontsMissing(packs) }
            let missing = Set(meta.missing ?? [])
            let packs = (status?.downloadable ?? []).filter { !Set($0.families).isDisjoint(with: missing) }
                .map { CoreLyricPack(id: $0.id, title: $0.title, bytes: $0.bytes) }
            return .fontsMissing(packs)
        case "glyphs": return .glyphs(meta.characters ?? [])
        case "engine": return .engine
        default: return nil
        }
    }

    public var packs: [CoreLyricPack] {
        if case .fontsMissing(let packs) = self { return packs }
        return []
    }
    public var isFontsMissing: Bool {
        if case .fontsMissing = self { return true }
        return false
    }

    /// The note in the history panel.
    public func message(_ tr: Localizer) -> String {
        switch self {
        case .fontsMissing(let packs) where !packs.isEmpty:
            let names = Self.names(packs, tr.language), size = FontPackSize.text(packs.reduce(0) { $0 + $1.bytes })
            return tr("Drawn in the classic style: JIZURA needs the \(names) (\(size)).",
                      "已用经典风格绘制：JIZURA 需要\(names)（\(size)）。",
                      ja: "クラシックスタイルで描きました。JIZURA には\(names)（\(size)）が必要です。")
        case .fontsMissing:
            return tr("Drawn in the classic style: JIZURA needs fonts that are not on this Mac.", "已用经典风格绘制：JIZURA 需要本机没有的字体。")
        case .glyphs(let characters) where !characters.isEmpty:
            let list = Self.characterList(characters)
            return tr("Drawn in the classic style: JIZURA's fonts have no \(list).",
                      "已用经典风格绘制：JIZURA 的字体里没有 \(list)。",
                      ja: "クラシックスタイルで描きました。JIZURA のフォントには \(list) がありません。")
        case .glyphs:
            return tr("Drawn in the classic style: JIZURA's fonts lack some characters of this text.", "已用经典风格绘制：JIZURA 的字体缺少这段文字中的部分字符。")
        case .engine:
            return tr("JIZURA could not start, so the classic style was used.", "JIZURA 无法启动，已改用经典风格。")
        }
    }

    /// The caret bubble after a shortcut: the note, and where to get the fonts.
    public func bubble(_ tr: Localizer) -> String {
        guard case .fontsMissing = self else { return message(tr) }
        return message(tr) + (tr.language == .english ? " " : "")
            + tr("Download them in clipboard history or Settings › Templates.", "可在剪贴板历史或“设置 › 模板”中下载。")
    }

    /// "Simplified Chinese lyric fonts", "… and …" in the UI language.
    static func names(_ packs: [CoreLyricPack], _ language: UILanguage) -> String {
        let titles = packs.map { $0.title.text(language) }
        guard language == .english, titles.count > 1 else { return titles.joined(separator: "、") }
        return titles.dropLast().joined(separator: ", ") + " and " + titles.last!
    }

    /// At most five characters, invisible ones as code points, held on one
    /// line by no-break spaces.
    static func characterList(_ characters: [String]) -> String {
        let shown = characters.prefix(5).map { character -> String in
            let visible = character.unicodeScalars.contains { !$0.properties.isWhitespace && $0.properties.generalCategory != .format && $0.properties.generalCategory != .control }
            return visible ? character : character.unicodeScalars.map { String(format: "U+%04X", $0.value) }.joined(separator: "\u{00A0}")
        }
        return (shown + (characters.count > 5 ? ["…"] : [])).joined(separator: "\u{00A0}")
    }
}
