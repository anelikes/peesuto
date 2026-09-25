import XCTest
@testable import PeesutoKit

final class TaskFeedbackTests: XCTestCase {
    let visible = CGRect(x: 0, y: 0, width: 1440, height: 875)
    let dot = CGSize(width: 22, height: 22)

    func testAnchorIsTheCaretInAppKitCoordinatesElseThePointer() {
        let caret = FeedbackPlacement.anchor(caretAccessibility: CGRect(x: 100, y: 200, width: 0, height: 20),
                                             pointer: CGPoint(x: 5, y: 5), primaryScreenHeight: 900)
        XCTAssertEqual(caret, .caret(CGRect(x: 100, y: 680, width: 0, height: 20)))
        XCTAssertEqual(FeedbackPlacement.anchor(caretAccessibility: nil, pointer: CGPoint(x: 5, y: 6), primaryScreenHeight: 900),
                       .pointer(CGPoint(x: 5, y: 6)))
        // Apps that answer {0,0,0,0} for "unknown" fall back to the pointer.
        XCTAssertEqual(FeedbackPlacement.anchor(caretAccessibility: .zero, pointer: CGPoint(x: 5, y: 6), primaryScreenHeight: 900),
                       .pointer(CGPoint(x: 5, y: 6)))
    }

    func testIndicatorSitsRightAfterTheCaretOnItsLine() {
        let caret = CGRect(x: 400, y: 500, width: 0, height: 18)
        let frame = FeedbackPlacement.indicatorFrame(size: dot, anchor: .caret(caret), visible: visible)
        XCTAssertEqual(frame.minX, caret.maxX + FeedbackPlacement.caretGap)
        XCTAssertEqual(frame.midY, caret.midY)
        // At the right edge it stays on screen.
        let edge = FeedbackPlacement.indicatorFrame(size: dot, anchor: .caret(CGRect(x: 1439, y: 500, width: 0, height: 18)), visible: visible)
        XCTAssertEqual(edge.maxX, visible.maxX - FeedbackPlacement.margin)
    }

    func testIndicatorFallsBackToBesideThePointer() {
        let point = CGPoint(x: 700, y: 400)
        let frame = FeedbackPlacement.indicatorFrame(size: dot, anchor: .pointer(point), visible: visible)
        XCTAssertGreaterThan(frame.minX, point.x - dot.width, "not under the arrow's hot spot")
        XCTAssertLessThan(frame.maxY, point.y, "below the hot spot, clear of the arrow's tip")
        XCTAssertTrue(visible.contains(frame))
        let corner = FeedbackPlacement.indicatorFrame(size: dot, anchor: .pointer(CGPoint(x: 1440, y: 0)), visible: visible)
        XCTAssertTrue(visible.insetBy(dx: FeedbackPlacement.margin, dy: FeedbackPlacement.margin).contains(corner))
    }

    func testBubbleGoesUnderTheCaretOrAboveWhenThereIsNoRoom() {
        let size = CGSize(width: 240, height: 30)
        let caret = CGRect(x: 400, y: 500, width: 0, height: 18)
        let below = FeedbackPlacement.bubbleFrame(size: size, anchor: .caret(caret), visible: visible)
        XCTAssertLessThan(below.maxY, caret.minY)
        let low = CGRect(x: 400, y: 10, width: 0, height: 18)
        let above = FeedbackPlacement.bubbleFrame(size: size, anchor: .caret(low), visible: visible)
        XCTAssertGreaterThan(above.minY, low.maxY)
        let right = FeedbackPlacement.bubbleFrame(size: size, anchor: .caret(CGRect(x: 1430, y: 500, width: 0, height: 18)), visible: visible)
        XCTAssertEqual(right.maxX, visible.maxX - FeedbackPlacement.margin)
        let pointer = FeedbackPlacement.bubbleFrame(size: size, anchor: .pointer(CGPoint(x: 700, y: 400)), visible: visible)
        XCTAssertLessThan(pointer.maxY, 400)
    }

    func testScreenIsTheOneHoldingTheAnchor() {
        let frames = [CGRect(x: 0, y: 0, width: 1440, height: 900), CGRect(x: 1440, y: 0, width: 1920, height: 1080)]
        XCTAssertEqual(FeedbackPlacement.screenIndex(containing: CGPoint(x: 2000, y: 300), frames: frames), 1)
        XCTAssertEqual(FeedbackPlacement.screenIndex(containing: CGPoint(x: -50, y: 300), frames: frames), 0)
        XCTAssertEqual(FeedbackPlacement.screenIndex(containing: nil, frames: frames), 0)
        XCTAssertNil(FeedbackPlacement.screenIndex(containing: CGPoint(x: 1, y: 1), frames: []))
        XCTAssertEqual(FeedbackPlacement.point(of: .caret(CGRect(x: 10, y: 20, width: 0, height: 10))), CGPoint(x: 10, y: 25))
    }

    func testBubbleStaysLongerForLongerText() {
        XCTAssertEqual(FeedbackTiming.bubbleDuration(for: "Copied"), FeedbackTiming.shortestBubble)
        let long = FeedbackTiming.bubbleDuration(for: "Copied only: a password field is active, so Peesuto does not type into it. Press ⌘V yourself if you mean to.")
        XCTAssertGreaterThan(long, FeedbackTiming.shortestBubble)
        XCTAssertLessThanOrEqual(long, FeedbackTiming.longestBubble)
        XCTAssertGreaterThan(FeedbackTiming.bubbleDuration(for: "已复制，请在需要的位置按 ⌘V。仅复制：当前是密码输入状态"),
                             FeedbackTiming.bubbleDuration(for: "Copied. Press it now"), "CJK counts double")
        XCTAssertEqual(FeedbackTiming.bubbleDuration(for: String(repeating: "x", count: 2000)), FeedbackTiming.longestBubble)
    }

    func testOnlyPlainEscCancels() {
        XCTAssertTrue(FeedbackKeys.cancels(keyCode: 53, command: false, option: false, control: false))
        XCTAssertFalse(FeedbackKeys.cancels(keyCode: 53, command: true, option: false, control: false))
        XCTAssertFalse(FeedbackKeys.cancels(keyCode: 53, command: false, option: true, control: false))
        XCTAssertFalse(FeedbackKeys.cancels(keyCode: 36, command: false, option: false, control: false))
    }
}
