---
name: bb-setup
description: Walk a coach through setting up Booking Bandit's Local Claude Engine on their own computer, from "nothing installed but Claude Desktop" through a working DM draft. Covers the Node/Claude Code CLI dependency check, installing the CLI, the interactive Claude sign-in, the helper installer, loading the Chrome extension, the account gate, and the final in-panel test. Use when the coach says "set up Booking Bandit", "install the local engine", "/bb-setup", "get Booking Bandit working on my computer", or when they have the beta bundle and don't know what to do with it. Also handles "Booking Bandit stopped working" by running the doctor.
---

# Booking Bandit Local Engine setup

You are walking a **coach**, not a developer, through this. Assume they have never
opened a terminal. Assume "npm", "PATH", and "native messaging" mean nothing to them
and should never appear in what you say out loud.

Definition of done: the coach clicks **Test local engine** in the Booking Bandit (Beta)
side panel and sees **green**, then generates one real DM draft.

## The two-lane rule (most important thing in this file)

Every command falls in exactly one of two lanes. Do not mix them up.

**Lane A ... you run it.** Read-only checks. Run these yourself with Bash/PowerShell.
Never make the coach run a check. It wastes their time and they misread the output.

**Lane B ... they run it.** Anything that installs software, signs them in, or changes
their machine. Put it in its own fenced ```bash (or ```powershell) block, one command
per block, and tell them to press the play button on the block. Then wait for them to
paste the result back before moving on.

Two reasons for Lane B, and both matter:
1. `claude` sign-in is **interactive**. It opens a browser and waits for a keypress in a
   real terminal. If you try to run it, it hangs forever and you will both be confused.
2. Installing software on someone's machine is their call, not yours. A block with a
   play button is them saying yes.

## Before you start

Figure out which computer you are on. Run this yourself (Lane A):

- macOS or Windows? Check the platform.
- Where is the beta bundle? It is the folder containing `extension-beta/`,
  `local-engine/`, and the two `Install Booking Bandit ...` files. If you were opened
  inside it, you are already there. If not, ask the coach to tell you the folder, or
  look in Downloads and Desktop.

Say what you found in one line, then go to Step 1. Do not narrate the plan.

---

## Step 1 ... dependency check (Lane A, you run all of these)

Run all three. Do not stop at the first failure ... you want the full picture before you
tell them anything.

| Check | Command | What it means |
|---|---|---|
| Node | `node --version` | Must be v18 or higher. The helper runs on it. |
| Claude Code CLI | `claude --version` | This is the piece most coaches are missing. |
| Chrome | look for Google Chrome installed | Chrome only. Not Comet, not Edge, not Safari. |

Then branch:

- **Node missing or below v18** ... stop here. Do not try to install Node. Tell the coach:
  "Your computer is missing a piece I can't safely install for you. Send Joe this message:
  *Booking Bandit setup ... Node is missing on my machine, need a hand.*" Then stop.
- **Chrome missing** ... stop. The extension is Chrome-only. Tell them to install Chrome
  first, then come back.
- **Claude Code CLI missing** ... go to Step 2.
- **Everything present** ... skip to Step 4. Say so: "Good news, you already have
  everything you need. Skipping ahead."

---

## Step 2 ... install the Claude Code CLI (Lane B)

Say this first, in your own words, short:

> You already have Claude on your desktop. This installs the version that runs in the
> background so Booking Bandit can borrow it. Same account, same subscription, nothing
> extra to pay for.

Then give them exactly this block and tell them to press play on it:

```bash
npm install -g @anthropic-ai/claude-code
```

**Do not retype this command from memory.** The exact package name is
`@anthropic-ai/claude-code`. Getting one character wrong here has already cost a real
coach four minutes on a live call.

Wait for their result. Then:

- **Worked** ... go to Step 3.
- **"EACCES" or "permission denied"** (common on Mac) ... their npm folder needs
  permission. Give them this block instead, and tell them it will ask for their Mac
  password, which is normal:
  ```bash
  sudo npm install -g @anthropic-ai/claude-code
  ```
- **"npm: command not found"** ... Node isn't really installed even though Step 1 passed.
  Stop and escalate to Joe, same as the Node-missing case above.

Verify yourself (Lane A) with `claude --version` before moving on. Do not take their
word for it, and do not take "it looked like it worked" for it.

---

## Step 3 ... sign in to Claude (Lane B, interactive, do NOT run this yourself)

This is the step that scares people. Set expectations **before** you give them the block:

> This opens your browser to log into your Claude account. Then it asks you a few
> yes/no questions in the terminal. Say yes to all of them. One of them will ask about
> access to files on your computer ... that's it asking permission to be useful, it can't
> go do anything on its own without you telling it to.

That last sentence matters. A coach has already been spooked by this exact prompt.

Then the block:

```bash
claude
```

Tell them: press play, log in when the browser opens, come back to the terminal, then
press Enter and answer yes to the questions. Tell them to say **done** when they're
through it.

Verify it actually took (Lane A):

```
claude -p "reply with the word ready and nothing else"
```

**Judge this on the exit code and whether `ready` appears anywhere in the output. Do
not string-match the whole output.** Coaches accumulate plugins and hooks, and those
can print warnings around the answer. A real signed-in run looks like this ... exit 0,
the word `ready`, and then a pile of unrelated hook noise:

```
ready
claude.exe : SessionEnd hook [...] failed: jq: command not found
```

That is a **pass**. Exit 0 plus `ready` present is the signal. Anything about login,
authentication, or no credentials is a fail ... send them back through the block above.

Do not proceed on an unverified login. A half-finished sign-in here is invisible until
the very last step, and then it looks like the product is broken.

---

## Step 4 ... install the helper (Lane B)

This is the piece that lets Chrome talk to their Claude.

There is a double-click file for this, but if they already have you open, a block is
fewer steps. Give them the one that matches their computer:

**macOS:**
```bash
bash "./local-engine/install/install-mac.sh"
```

**Windows:**
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\local-engine\install\install-windows.ps1" -ExtensionId eoaibojoneilhiagjmmhbbgehnmloelj -Browser all
```

Run it from inside the bundle folder. If they are somewhere else, give them the full
path to the script instead of the relative one.

**The success signal is the words `SMOKE PASS`** near the end, not the fact that the
window closed. The installer pings itself end-to-end before it claims victory. If you
do not see `SMOKE PASS` in what they paste back, it did not work ... go to
**If something breaks** below.

---

## Step 5 ... load the extension into Chrome (guided, they click)

No commands here. Walk them through it one step at a time, and wait for them at each
one. Do not dump all five steps at once.

1. Open Chrome, go to `chrome://extensions`
2. Turn on **Developer mode** ... toggle in the top-right corner
3. Click **Load unpacked**
4. Pick the **`extension-beta`** folder inside the bundle (the folder itself, not a file
   inside it)
5. Check the ID it shows reads `eoaibojoneilhiagjmmhbbgehnmloelj`

If the ID is different, they picked the wrong folder. Have them remove it and redo
step 4.

---

## Step 6 ... sign in and check the gate

Have them open the **Booking Bandit (Beta)** side panel and sign in with Google, then
fill in their profile.

Now the part that has already bitten a real coach. Have them open **Settings** (gear) →
**Key** tab, and tell you what they see.

- **They see an engine choice with a "Local" option** ... good, have them pick Local, then
  go to Step 7.
- **They only see the bring-your-own-key / paid version, no Local option** ... their
  account is not switched on for the beta yet. **They cannot fix this themselves and
  neither can you.** It is a permission Joe flips on his end.

  Give them this to send Joe, filled in with the email they just signed in with:

  > Booking Bandit beta ... I'm installed but the Local engine option isn't showing up
  > in Settings. My sign-in email is: `<their email>`

  Then stop and wait. Once Joe confirms, have them reload the extension on
  `chrome://extensions` and check Settings again.

---

## Step 7 ... full restart, then the real test

**A normal window-close is not enough.** Chrome only notices the helper after it fully
quits. This is the single most common reason setup "didn't work."

**macOS:** Cmd-Q on Chrome. Tell them to check the dock ... if the dot under Chrome is
still there, it's still running.

**Windows:** close every Chrome window, then run this block to be certain:
```powershell
Stop-Process -Name chrome -Force
```

Then, in a freshly opened Chrome:

1. Open the **Booking Bandit (Beta)** side panel
2. Gear → **Settings** → **Key** tab → click **Test local engine**
3. Green = done

Green is the finish line, not "the installer said SMOKE PASS." Then have them run one
real **Generate** on an actual DM thread so they see it work on their own conversation.

---

## If something breaks (now or three weeks from now)

Run these in order. Stop at the first one that explains it.

**1. Did they fully quit Chrome?** Ask. Nine times out of ten this is it, including for
a setup that worked yesterday and doesn't today. Have them Cmd-Q / kill Chrome and
retest before anything else.

**2. The in-panel self-test.** Settings → Key → **Test local engine**, then **Deep test**.
If a red error card appears it has a **Copy diagnostics** button ... have them click it
and paste the result to you.

**3. The doctor.** Read-only, safe to run any time (Lane B):

**macOS:**
```bash
bash "./local-engine/install/doctor-mac.sh" --ping
```

**Windows:**
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\local-engine\install\doctor-windows.ps1" -Ping
```

Read the `FAIL` lines. Most of them end with "re-run install-mac.sh" or
"re-run install-windows.ps1" ... which means go back to Step 4. `ALL CHECKS PASSED` plus
a still-broken panel means the browser was never fully restarted ... go back to step 1
of this list.

**4. Escalate.** If the doctor passes, Chrome was fully restarted, and the panel still
fails, it is not something the coach can fix. Have them send Joe: a screenshot of the
doctor output, and the **Copy diagnostics** text from the error card.

---

## Things not to do

- Do not run `claude` yourself to "test" the login. It is interactive. It will hang.
- Do not try to install Node, Homebrew, or Chrome for them. Out of scope, escalate.
- Do not tell a coach to run `bb-doctor`, `bb-setup`, or `bb-update` as terminal
  commands. Those names appear in some older error messages but they are not real
  commands and will fail with "command not found." The real doctor is the script path
  in the block above.
- Do not skip the verification after Step 2 and Step 3. Both failures are silent until
  the very end, and then they look like the product is broken.
- Do not say "native messaging host", "manifest", "PATH", or "stdin" out loud. Say
  "the helper" and "the piece that lets Chrome talk to your Claude."
