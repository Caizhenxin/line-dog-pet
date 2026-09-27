import CoreGraphics
import Foundation

// 系统级移动鼠标光标（macOS）。
// 用法: move-mouse <x> <y>          —— 移动到屏幕全局坐标（主屏左上角为原点）
//       move-mouse --delta <dx> <dy> —— 相对当前光标位置移动
// 依赖「辅助功能」权限（首次运行系统会弹授权）。

let args = CommandLine.arguments
var tx: Double?, ty: Double?, rel = false
var i = 1
while i < args.count {
    switch args[i] {
    case "--delta": rel = true
    default:
        if tx == nil { tx = Double(args[i]) } else if ty == nil { ty = Double(args[i]) }
    }
    i += 1
}
guard let x = tx, let y = ty else {
    print("usage: move-mouse <x> <y> | --delta <dx> <dy>")
    exit(2)
}
var point: CGPoint
if rel {
    let cur = CGEvent(source: nil)?.location ?? .zero
    point = CGPoint(x: cur.x + x, y: cur.y + y)
} else {
    point = CGPoint(x: x, y: y)
}
let ev = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                 mouseCursorPosition: point, mouseButton: .left)
ev?.post(tap: .cghidEventTap)
print("moved to \(point.x),\(point.y)")
exit(0)
