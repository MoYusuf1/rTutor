# rlearn

A personal tutor on your computer. Tell it what you want to learn, or give it your own material
(a textbook chapter, slides, a video transcript), and it teaches you one small step at a time.

## How it teaches

1. It asks a few quick questions to find out what you already know.
2. It shows you a plan for getting from there to your goal.
3. It explains one idea at a time and checks each one with a short quiz, keeping notes on what you've
   got and what you missed.

## Get started

You need [Node.js](https://nodejs.org) and [Rust](https://rustup.rs). Then, in this folder:

```bash
npm install
npm run tauri dev
```

Click **Model** (bottom left) to choose who teaches you: **Claude Code** or **Codex** use the subscription
you're already signed into, or paste an API key (NVIDIA, Anthropic, OpenAI and others).

## Credits

The teaching method comes from Amos Blomqvist: his video
[How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU) and his
[learn](https://github.com/amosblomqvist/learn) setup. Built with [Tauri](https://tauri.app).
