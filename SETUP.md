# Capture for rabbit r1: setup

Setup takes about 30 minutes, and you only do it once. After that, you hold the side button on the r1, talk, and the entry ends up in your vault.

## How it works

1. **Hold the side button and talk.** This works offline. The audio is saved on the r1.
2. **When the r1 is on Wi-Fi or a hotspot**, it turns the audio into text (Groq, free tier) and the r1's built-in AI sorts it into a task, event, or note and pulls out any date or time.
3. **The entry is pushed to a private GitHub repo.** On your PC, the Obsidian Git plugin pulls it into your vault, and Obsidian Sync carries it to your phone.

Status dots on the r1: gray = waiting for a connection, amber = working, blue = ready to send, green = in the vault, red = needs attention (tap it to see why).

Voice tips: start with "task", "event", or "note" if you want to pick the type yourself. Otherwise it guesses. Dates like "tomorrow" or "Friday at 3" are worked out from the time you recorded.

In the vault, each day gets one file, `R1 Inbox/MM-DD-YYYY.md`, with Tasks, Events, and Notes sections. Every line ends with an `^r1-…` tag so nothing is added twice.

## Step 1: GitHub (free account)

1. Create a **public** repo named `r1-capture` and upload `index.html`, `app.css`, `app.js`, and `sw.js`. The app code has no keys or personal data in it.
2. In that repo, go to Settings → Pages → Deploy from branch → `main` / root. After about a minute, your app lives at `https://<you>.github.io/r1-capture/`.
3. Create a **private** repo named `r1-inbox` and check "Add a README" so the repo isn't empty. Your notes go here.
4. Create a token: Settings (your profile) → Developer settings → Fine-grained tokens → Generate. Set Repository access to **Only select repositories → r1-inbox**, and Permissions to **Contents: Read and write**. Copy the token.

## Step 2: Groq key (free, no card)

Sign up at console.groq.com → API Keys → Create. Copy the key. Groq's free tier allows thousands of short clips a day.

## Step 3: Put the inbox inside your vault (Windows PC only)

1. Install Git for Windows (git-scm.com). Keep the default options.
2. Open your vault folder in File Explorer, click the address bar, type `cmd`, and press Enter. Then run:
   `git clone https://github.com/<you>/r1-inbox.git "R1 Inbox"`
   A browser window will open so you can sign in to GitHub once.
3. In Obsidian on the PC: Settings → Community plugins → install and enable **Git** (by Vinzent). In its settings:
   - Advanced → **Custom base path (Git repository path)**: `R1 Inbox`
   - **Auto pull interval**: 5 minutes, and turn on **Pull on startup**
   - **Auto commit-and-sync interval**: 5 minutes (so tasks you check off get saved back to the repo)
4. Only the PC runs Git. If Obsidian Sync is set to sync community plugins, turn the Git plugin off on your phone. The phone gets the notes through Obsidian Sync anyway.

The repo only covers the `R1 Inbox` folder. The rest of your vault never goes to GitHub.

## Step 4: Install on the r1

1. Open `setup.html` on your PC and fill in the app URL, `<you>`, `r1-inbox`, the token, and the Groq key, then click **Make QR codes**.
2. Scan **QR A** with the r1 to install the creation. If that doesn't work, use Rabbit's own creation QR maker with the same URL.
3. Open Capture on the r1 → ⚙ → **Scan setup QR** → point it at **QR B**. Then tap **Test connection**. You should see "GitHub: OK · Groq: OK".
   If scanning isn't supported, type the values into the boxes instead (a Bluetooth keyboard makes this much easier).
4. Close setup.html. QR B contains your keys.

## First test (do this before relying on it)

1. Turn Wi-Fi off on the r1, open Capture, and hold the side button for a short test note. If the app won't open offline, or the mic doesn't record, tell Claude what happened. These are the two things that haven't been confirmed on real r1 hardware.
2. Turn Wi-Fi back on. Within a minute, the dot should go amber, then green.
3. On your PC, wait up to 5 minutes, or run Git: Pull from the command palette, and check `R1 Inbox`.

## Controls

| Action | r1 |
|---|---|
| Record | Hold side button, release to save (5 minutes max) |
| Move through the list | Scroll wheel |
| Open an entry / go back | Click side button, or tap |
| Type instead of talking | + Type |
| Send now, retry errors | ⟳ at the top, or Send in an entry |
| Fix the type | Open the entry → Task / Event / Note (before it's sent) |

Turning off "Send to vault automatically" in Settings means entries stay blue until you press Send or ⟳. You can then send a batch whenever you want.

Deleting an entry on the r1 removes it from the r1 list only. Anything already sent stays in the vault.

Testing on a PC: serve the folder from any local web server and open index.html. There, the arrow keys act as the scroll wheel, Enter acts as a side-button click, and holding Space records.
