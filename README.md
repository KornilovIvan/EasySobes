# EasySobes

EasySobes is a free, open-source AI interview assistant. It is a small overlay that stays on top of your screen during a live call, listens to the interviewer, and shows a short answer you can say out loud. The window is left out of screenshots and screen sharing, so the other person does not see it.

It is an interview copilot for technical and behavioral interviews: coding questions, system design, and ordinary spoken questions. There is no EasySobes account and no subscription. You bring your own API key. Speech, text, and images can each go to a different OpenAI-compatible provider, such as Groq or DeepSeek.

## What it is for

On a call it is awkward to switch away and type the question into a chat. EasySobes sits beside the meeting, hears the interviewer's audio from the computer, and answers by itself. It does not record your microphone. You can also type a question, or send the screen when the question is a coding problem already on display.

Use it when you want a private overlay for a job interview or a meeting, hidden from the shared screen, with answers grounded in notes you provide for that chat.

## Features

- **Live listen.** Hears the interviewer from system audio and answers without a click for each question. The model decides which line is a real question and which line can be skipped.
- **Typed questions.** The box at the bottom of the window works with Live turned off.
- **One recording.** Capture a short stretch of audio, then answer that stretch.
- **Screen question.** Sends one screenshot when you ask. The screen is not captured on its own.
- **Spoken answer and solution.** A short answer stays in the chat. Code or a system-design sketch opens in a panel on the right, with syntax highlighting.
- **Chats and context.** Each chat keeps its own background: role, stack, notes, and code in Markdown. That background is sent with later answers for that chat.
- **Languages.** Auto, English, Russian, Hindi, or Hinglish. Auto answers in the language of the question.
- **Window.** Show and hide, move with the arrow keys, opacity, and click-through. Black or white theme, adjustable text size.
- **Your keys.** Speech, chat, and vision each have their own base URL, API key, and model. A blank field keeps the shared URL and key. Keys and chats stay on this computer.

The overlay uses the operating system's content protection, so normal screenshots and screen shares omit the window. Test it in the meeting app you actually use (Zoom, Google Meet, Teams) before a real call. Whether a window stays hidden depends on how that app captures the screen.

## Hotkeys

On macOS the modifier is Command+Shift. On Windows it is Ctrl+Shift.


| Keys                              | Action                                                            |
| --------------------------------- | ----------------------------------------------------------------- |
| Command+Shift+L                   | Live: listen and answer                                           |
| Command+Shift+R                   | Record a clip and answer. During Live, answer the latest line now |
| Command+Shift+Enter               | Read the screen and answer                                        |
| Command+Shift+I                   | Focus the question box                                            |
| Command+Shift+K                   | Clear the current chat                                            |
| Command+Shift+Space               | Show or hide the window                                           |
| Command+Shift+T                   | Click-through: clicks pass to apps underneath                     |
| Command+Shift+O / Command+Shift+P | More transparent / more solid                                     |
| Command+Shift+Arrows              | Move the window                                                   |
| Command+Shift+Q                   | Quit                                                              |


## Run it

Requires [Node.js 20+](https://nodejs.org). macOS and Windows.

```bash
git clone https://github.com/KornilovIvan/EasySobes.git
cd EasySobes
npm install
npm start
```

On first launch, open Settings, paste the base URL and API key for speech, text, and images, and click Save.

On macOS, system-audio permission is granted to the app that starts EasySobes, usually Terminal or your editor. After you allow it, quit that app completely and open it again.

Settings and chats are stored only on this computer:

- macOS: `~/Library/Application Support/easysobes/`
- Windows: `%APPDATA%\easysobes\`

## License

[MIT](LICENSE)