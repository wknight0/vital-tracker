#Requires AutoHotkey v2.0
; Press F9 to open the app URL. Try to open in a new tab when possible.
F9:: {
    url := "http://127.0.0.1:8081/"
    cmd := 'firefox.exe -new-window "' url '"'
        Run cmd
        return
}