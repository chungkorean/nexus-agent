//go:build windows

// Nexus.exe: 두 번 누르면 Nexus를 켜고 앱 창을 연다.
// 실제 일은 scripts\windows\nexus-tray.ps1(트레이 실행기)이 하고, 이 프로그램은
// 준비가 됐는지 확인한 뒤 트레이 실행기를 창 없이 띄운다. 이미 켜져 있으면 앱 창만 열린다.
package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

const (
	mbOK           = 0x00000000
	mbYesNo        = 0x00000004
	mbIconError    = 0x00000010
	mbIconQuestion = 0x00000020
	mbIconInfo     = 0x00000040
	idYes          = 6
	createNoWindow = 0x08000000
)

var messageBox = syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")

func ask(text string, flags uintptr) int {
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString("Nexus")
	r, _, _ := messageBox.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), flags)
	return int(r)
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// Nexus.exe가 있는 폴더부터 위로 올라가며 저장소(트레이 실행기가 있는 곳)를 찾는다.
func findRepo() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	dir := filepath.Dir(exe)
	for i := 0; i < 4; i++ {
		if exists(filepath.Join(dir, "scripts", "windows", "nexus-tray.ps1")) {
			return dir
		}
		up := filepath.Dir(dir)
		if up == dir {
			break
		}
		dir = up
	}
	return ""
}

func main() {
	repo := findRepo()
	if repo == "" {
		ask("Nexus 폴더를 찾지 못했어요.\n\nNexus.exe는 nexus-agent 폴더 안(README.md가 있는 곳)에 두고 실행해 주세요.", mbOK|mbIconError)
		os.Exit(1)
	}
	if _, err := exec.LookPath("node"); err != nil {
		ask("Node.js가 없어요.\n\nhttps://nodejs.org 에서 Node.js 24 LTS(24.11 이상)을 설치한 뒤 다시 실행해 주세요.", mbOK|mbIconError)
		os.Exit(1)
	}

	// 처음 실행이면 패키지를 설치하고 어댑터를 빌드한다(보이는 창에서, 끝날 때까지 기다림).
	ready := exists(filepath.Join(repo, "node_modules")) && exists(filepath.Join(repo, "packages", "paperclip-adapter", "dist"))
	if !ready {
		if ask("처음 실행이라 준비가 필요해요.\n\n필요한 패키지를 설치하고 Nexus를 빌드할까요? 몇 분 걸려요.", mbYesNo|mbIconQuestion) != idYes {
			os.Exit(0)
		}
		cmd := exec.Command("cmd.exe", "/c", "title Nexus 준비 중 && npx --yes pnpm@10 install && npx --yes pnpm@10 build || (echo. & echo 준비하지 못했어요. 위 오류를 확인해 주세요. & pause & exit /b 1)")
		cmd.Dir = repo
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000010} // CREATE_NEW_CONSOLE
		if err := cmd.Run(); err != nil {
			os.Exit(1)
		}
	}

	ps := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	if !exists(ps) {
		ps = "powershell.exe"
	}
	tray := filepath.Join(repo, "scripts", "windows", "nexus-tray.ps1")
	cmd := exec.Command(ps, "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", tray, "-OpenApp")
	cmd.Dir = repo
	// HideWindow(SW_HIDE)는 쓰지 않는다: 그 값이 PowerShell이 처음 띄우는 창(설치 화면, 켜는 중 화면)에도
	// 적용돼 창이 보이지 않게 된다. 콘솔은 CREATE_NO_WINDOW로 이미 없다.
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow}
	if err := cmd.Start(); err != nil {
		ask("Nexus를 켜지 못했어요: "+err.Error(), mbOK|mbIconError)
		os.Exit(1)
	}
	_ = cmd.Process.Release()
}
