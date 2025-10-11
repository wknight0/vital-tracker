#Requires AutoHotkey v2.0
; F9: Open Vital Tracker in an app-mode window at a fixed size and prevent resizing.

; === Adjustable window size ===
VITAL_WIDTH  := 1000
VITAL_HEIGHT := 760

F9::{
    url := "http://127.0.0.1:8081/"

    ; Prefer Microsoft Edge app mode if available, fallback to Chrome if present
    pf64 := A_ProgramFiles
    pf86 := EnvGet("ProgramFiles(x86)")

    edge64 := pf64 ? pf64 "\\Microsoft\\Edge\\Application\\msedge.exe" : ""
    edge32 := pf86 ? pf86 "\\Microsoft\\Edge\\Application\\msedge.exe" : ""
    chrome64 := pf64 ? pf64 "\\Google\\Chrome\\Application\\chrome.exe" : ""
    chrome32 := pf86 ? pf86 "\\Google\\Chrome\\Application\\chrome.exe" : ""

    cmd := ""
    if (FileExist(edge64)) {
        cmd := '"' edge64 '" --app="' url '" --window-size=' VITAL_WIDTH ',' VITAL_HEIGHT
    } else if (FileExist(edge32)) {
        cmd := '"' edge32 '" --app="' url '" --window-size=' VITAL_WIDTH ',' VITAL_HEIGHT
    } else if (FileExist(chrome64)) {
        cmd := '"' chrome64 '" --app="' url '" --window-size=' VITAL_WIDTH ',' VITAL_HEIGHT
    } else if (FileExist(chrome32)) {
        cmd := '"' chrome32 '" --app="' url '" --window-size=' VITAL_WIDTH ',' VITAL_HEIGHT
    }

    if (cmd != "") {
        Run cmd
        ; After the window appears, enforce size and disable resizing.
        CenterAndFixWindow("Vital Tracker", VITAL_WIDTH, VITAL_HEIGHT)
    }
}

CenterAndFixWindow(title, w, h) {
    ; Wait up to 5s for the app window to appear (title from index.html)
    if !WinWait(title, , 5) {
        return
    }
    try {
        x := Round((A_ScreenWidth - w) / 2)
        y := Round((A_ScreenHeight - h) / 2)
        WinMove(x, y, w, h, title)

        ; Remove resizing and maximize capabilities
        WS_THICKFRAME  := 0x00040000
        WS_MAXIMIZEBOX := 0x00010000
        WinSetStyle("-" . Format("0x{:X}", WS_THICKFRAME), title)
        WinSetStyle("-" . Format("0x{:X}", WS_MAXIMIZEBOX), title)
    } catch as e {
        ; Ignore if window ops fail
    }
}
