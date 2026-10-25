# EasySobes

[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)

A free, open-source AI helper for interviews and meetings. It floats on top of your screen,
listens to the other people on the call, and shows a short answer you can say out loud.
It is left out of screen shares and screenshots, so only you see it.

- **Free.** Uses your own free [Groq](https://console.groq.com/keys) API key. No account with us, no subscription.
- **Private.** Your key, profile and resume stay on your computer. Nothing goes anywhere except the AI provider you choose.
- **macOS and Windows.**
- **Hands-free.** It starts listening by itself and answers questions automatically.
- **English, Russian, Hindi and Hinglish.** Choose the language in ⚙ Settings.
- Reads your screen for coding questions, and knows your resume so it answers *as you*.

## Install

Pick **one** of these. All three give you the same `sobes` command.

| Your computer | Command |
|---|---|
| **Any system with Node.js 20+** | `npm install -g easysobes` |
| **macOS** (no Node.js needed) | `curl -fsSL https://raw.githubusercontent.com/KornilovIvan/EasySobes/main/install.sh \| bash` |
| **Windows 10/11** (no Node.js needed) | `irm https://raw.githubusercontent.com/KornilovIvan/EasySobes/main/install.ps1 \| iex` |

Then type:
```bash
sobes
```

### Option 1: npm
If you already have [Node.js](https://nodejs.org) 20 or newer (check with `node -v`), this works on macOS and Windows:
```bash
npm install -g easysobes
sobes
```
The first `sobes` downloads Electron (about 100 MB) and runs the setup wizard.
If another tool already owns the `sobes` command, use `easysobes` instead. It does the same thing.

> On macOS, if npm says `EACCES` (permission denied), don't use `sudo`. Use Option 2 instead,
> or install Node.js with [nvm](https://github.com/nvm-sh/nvm).

### Option 2: macOS one-line installer
Open Terminal and paste:
```bash
curl -fsSL https://raw.githubusercontent.com/KornilovIvan/EasySobes/main/install.sh | bash
```

### Option 3: Windows one-line installer
Open PowerShell and paste:
```powershell
irm https://raw.githubusercontent.com/KornilovIvan/EasySobes/main/install.ps1 | iex
```

Options 2 and 3 need nothing installed first. They download Node.js by themselves when you don't have it.

Want to remove EasySobes later? See [Uninstall](#uninstall).

### What setup asks you
The first time, EasySobes asks for:
1. your **Groq API key**. Get one free at [console.groq.com/keys](https://console.groq.com/keys). EasySobes checks that the key works.
2. a few details about you: name, the job role, experience, top skills,
3. your **resume**. Drag the PDF or Word file into the terminal window and press Enter.

Everything is saved only on your computer. Run `sobes setup` any time to change it.
The whole install takes about two minutes. The one-line installers keep everything in a `.easysobes` folder in your home folder and need no admin password.

## Use it

```
sobes           start EasySobes
sobes setup     change your API key, profile or resume
sobes update    get the latest version
sobes help      list the commands
```

After `sobes`, the overlay appears in the top-right corner and starts listening after a second.
When someone asks a question, the answer shows up by itself.

To change the language EasySobes listens for, open ⚙ Settings → "Language they speak".
**Auto** answers in the language of the question. The other choices are English, Russian, हिंदी and Hinglish.

### Hotkeys
On macOS the keys are ⌘⇧ (Command+Shift). On Windows they are Ctrl+Shift.

| Keys | Action |
|---|---|
| ⌘⇧Space | Show / hide |
| ⌘⇧L | Live listen on/off (answers questions automatically) |
| ⌘⇧R | Answer what was just said, right now |
| ⌘⇧Enter | Read the screen and answer (coding problems, questions) |
| ⌘⇧I | Type a question |
| ⌘⇧M | Answer mode: Interview / Coding / General |
| ⌘⇧K | Clear |
| ⌘⇧T | Click-through (clicks pass through the window) |
| ⌘⇧O / ⌘⇧P | Less / more opacity |
| ⌘⇧Arrows | Move the window |
| ⌘⇧Q | Quit |

## First run on macOS: permissions
macOS gives screen and audio permission to the app that **starts** EasySobes. If you start it from Terminal, that app is Terminal.

1. Run `sobes`. macOS asks to allow **Screen & System Audio Recording** for Terminal. Allow it.
   If nothing asks, open System Settings → Privacy & Security → Screen & System Audio Recording and turn on Terminal.
2. **Quit Terminal completely** (⌘Q), open it again and run `sobes`.

If EasySobes shows "Listening" but never answers, this permission is almost always the reason.
If you use VS Code's terminal, VS Code needs the permission, and VS Code must be in /Applications. If it runs from Downloads, macOS forgets the permission every time.

On Windows no permission is needed. Hiding from screen shares needs Windows 10 version 2004 or newer.

## Good to know
- EasySobes hears **all** sound your computer plays (the call, and also videos), but not your microphone, so it never answers your own voice.
- Always test in the app you share from (Zoom, Meet, Teams) before a real call. Whether a window stays hidden depends on how that app captures the screen.
- Groq's free tier allows about 7,000 input tokens per minute. Screen questions use the most. If you hit the limit, EasySobes waits and retries by itself.
- Your settings file: `~/Library/Application Support/easysobes/settings.json` (macOS) or `%APPDATA%\easysobes\settings.json` (Windows). The log file `easysobes.log` is in the same folder.
- Audio clips, screenshots and your resume text are sent to the AI provider (Groq by default) to make answers. Read their privacy policy if that matters to you.

### Fully offline (optional)
Install [Ollama](https://ollama.com), then in EasySobes's ⚙ Settings set the base URL to `http://localhost:11434/v1`, the key to `ollama`, and pick local models. Speech-to-text still needs a cloud key.

## Install by hand (for developers)
You need [Node.js 20+](https://nodejs.org) and git.
```bash
git clone https://github.com/KornilovIvan/EasySobes.git
cd EasySobes
npm install
npm start          # or: npm link, then type sobes anywhere
```
Without the wizard, click ⚙ in the overlay, paste your key, click **📄 Load resume**, and click Save.
You can also run the wizard with `npm run setup`.

### Build a desktop app
```bash
npm run dist       # macOS: dist/*.dmg (Apple Silicon)
npm run dist:win   # Windows: dist/*.exe installer
```
These builds are not code-signed. macOS may say the app is "damaged": run `xattr -cr "/Applications/EasySobes.app"`.
Windows SmartScreen shows "Windows protected your PC": click More info → Run anyway.

## Uninstall

**First, quit EasySobes:** press ⌘⇧Q on macOS or Ctrl+Shift+Q on Windows.
Then use the steps for the way you installed it.

> The last command in each block deletes your saved settings: API key, profile and resume.
> Leave it out if you might reinstall later and want to keep them.

### macOS, installed with the one-line installer
Paste into Terminal:
```bash
rm -rf ~/.easysobes
sed -i '' -e '/^# EasySobes$/d' -e '/\.easysobes\/bin/d' ~/.zshrc ~/.bash_profile 2>/dev/null
rm -rf ~/Library/Application\ Support/easysobes
```
The first line removes EasySobes, the second removes the `sobes` command from your shell, and the third deletes your settings.

### Windows, installed with the one-line installer
Paste into PowerShell:
```powershell
Remove-Item -Recurse -Force "$HOME\.easysobes" -ErrorAction SilentlyContinue
$p = [Environment]::GetEnvironmentVariable('Path', 'User') -split ';' | Where-Object { $_ -and $_ -notlike '*\.easysobes\bin' }
[Environment]::SetEnvironmentVariable('Path', ($p -join ';'), 'User')
Remove-Item -Recurse -Force "$env:APPDATA\easysobes" -ErrorAction SilentlyContinue
```
The first line removes EasySobes, the next two remove the `sobes` command from your PATH, and the last deletes your settings.

### Installed with npm (any system)
```bash
npm uninstall -g easysobes
```
Then delete your settings: on macOS `rm -rf ~/Library/Application\ Support/easysobes`, on Windows (PowerShell) `Remove-Item -Recurse -Force "$env:APPDATA\easysobes"`.

### Installed with git clone
Delete the `sobes` folder you cloned. If you ran `npm link`, run `npm unlink -g easysobes` first. Then delete your settings as shown above.

### Optional: remove the macOS permission
System Settings → Privacy & Security → Screen & System Audio Recording → select your terminal app and click **−**.
Only do this if no other app you use needs it.

## Project layout
| File | What it does |
|---|---|
| `src/main.js` | Window, hotkeys, settings, AI calls |
| `src/audio-main.js`, `src/audio-renderer.js` | System-audio capture, voice detection, live mode |
| `src/renderer.js`, `src/index.html`, `src/styles.css` | The overlay UI |
| `src/prompts.js` | How answers are worded for each mode |
| `src/stealth.js` | Click-through, opacity, capture self-test |
| `src/resume.js` | Reads PDF / Word resumes |
| `bin/sobes.js`, `bin/setup.js` | The `sobes` command and the setup wizard |
| `install.sh`, `install.ps1` | One-line installers |
| `scripts/build.js` | Runs electron-builder (moves Electron to devDependencies just for the build) |

Plain JavaScript and Electron, no framework, no bundler. Pull requests are welcome.

## License
[MIT](LICENSE)
