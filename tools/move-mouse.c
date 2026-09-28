/* =============================================================================
   move-mouse.c —— 系统级移动鼠标光标（Windows 版，对应 macOS 的 move-mouse.swift）
   -----------------------------------------------------------------------------
   用法: move-mouse.exe <x> <y>          —— 移动到屏幕坐标（主屏左上角为原点）
         move-mouse.exe --delta <dx> <dy> —— 相对当前光标位置移动

   与 macOS 版的两处差异（调用方 src/goose-main.js 已按平台处理）：
     · 坐标是**物理像素**：Electron 的 screen 给的是 DIP（逻辑像素），调用方先
       用 screen.dipToScreenPoint() 换算再传进来，否则缩放 ≠100% 时光标会落错位置。
     · 不需要 macOS 的「辅助功能」授权，SetCursorPos 开箱即用。

   本进程按 per-monitor DPI aware v2 启动：不声明的话系统会对坐标做 DPI 虚拟化，
   多显示器不同缩放时坐标会被二次缩放。

   编译（Windows / MinGW-w64 gcc）:
     gcc -O2 -s -mwindows -o move-mouse.exe move-mouse.c
   ============================================================================= */

#include <windows.h>
#include <stdlib.h>
#include <string.h>

typedef BOOL (WINAPI *SetProcessDpiAwarenessContextFn)(HANDLE);

static void set_dpi_aware(void) {
    /* 先试 per-monitor v2（Win10 1703+），拿不到就退回系统级 DPI aware。 */
    HMODULE user32 = LoadLibraryA("user32.dll");
    if (user32) {
        SetProcessDpiAwarenessContextFn fn = (SetProcessDpiAwarenessContextFn)
            (void *)GetProcAddress(user32, "SetProcessDpiAwarenessContext");
        /* DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 == (HANDLE)-4 */
        if (fn && fn((HANDLE)-4)) return;
    }
    SetProcessDPIAware();
}

int main(int argc, char **argv) {
    int rel = 0;
    double val[2];
    int n = 0;
    int i;

    for (i = 1; i < argc && n < 2; i++) {
        if (strcmp(argv[i], "--delta") == 0) { rel = 1; continue; }
        val[n++] = atof(argv[i]);
    }
    if (n < 2) return 2;                    /* usage: 参数不足 */

    set_dpi_aware();

    if (rel) {
        POINT cur;
        if (!GetCursorPos(&cur)) return 1;
        cur.x += (LONG)val[0];
        cur.y += (LONG)val[1];
        SetCursorPos(cur.x, cur.y);
    } else {
        SetCursorPos((LONG)val[0], (LONG)val[1]);
    }
    return 0;
}