# Booking Bandit ... setup for a VA / setter

For an assistant setting this up on **their own computer**, using the coach's Claude
subscription. You do not need Claude Desktop, and you do not need to know what any of
this is. Four downloads and a login.

**The coach needs to be on this call with you.** One step uses their password, and they
should type it themselves.

Total time: about 20 minutes, most of it waiting on progress bars.

---

## What you need before you start

- **Google Chrome.** Not Safari, not Edge. If you don't have it: https://google.com/chrome
- **The coach on a screenshare** for Step 2.
- **Your own computer's password** (the one that unlocks your laptop). Two installers
  will ask for it. That's normal ... it's how Macs and PCs confirm you meant to install
  something.

---

## Step 0 ... install Node

This is a small free tool the helper runs on. Nothing to configure, nothing to open.

1. Go to **https://nodejs.org**
2. Click the big download button for the **LTS** version (LTS just means "the stable
   one"). The site figures out Mac vs Windows for you.
3. Open the file it downloads and click through: Continue, Agree, Install.
4. It asks for **your computer password**. Type it. That's expected.
5. When it says the install succeeded, close it.

**Then do this, it matters:** if you already had a black Terminal window open, **close
it and open a fresh one.** Terminal only notices new tools when it starts up. Skipping
this is the single most common reason the next step "doesn't work."

---

## Step 1 ... open a terminal and install Claude

**Mac:** press `Cmd` + `Space`, type `Terminal`, hit Enter.
**Windows:** press Start, type `PowerShell`, hit Enter.

A window with text in it opens. It looks intimidating. It is a text box.

Copy this line, paste it in, press Enter:

```
npm install -g @anthropic-ai/claude-code
```

It prints a lot of scrolling text for a minute or two. That's it working. Wait for it
to stop and give you a fresh prompt.

**If it says `permission denied` or `EACCES`** (Mac, fairly common), paste this instead
and enter your computer password when it asks:

```
sudo npm install -g @anthropic-ai/claude-code
```

Check it worked:

```
claude --version
```

A version number means you're good. `command not found` means Step 0's "open a fresh
terminal" didn't happen ... close the window, open a new one, try again.

---

## Step 2 ... the coach logs in (coach does this part)

In the same terminal, type:

```
claude
```

It opens a browser window asking to sign in.

**Coach: this is you.** Sign in with your own Claude account, then come back to the
terminal and answer the questions with Enter / yes. One of them asks about access to
files on the computer ... that's it asking permission to be useful, it can't go do
anything on its own.

When it's done you can close the terminal completely. The login stays put. Nobody has
to do this again.

---

## Step 3 ... install the helper

1. Download the bundle: https://github.com/joeoliveimpact/bb-local-beta-revxl
   → green **Code** button → **Download ZIP** → unzip it
2. Double-click the file for your computer:
   - **Mac:** `Install Booking Bandit (Mac).command`
   - **Windows:** `Install Booking Bandit (Windows).cmd`
3. A window opens and runs on its own. Wait for it to say **`SMOKE PASS`**. That's the
   success word. Press a key to close it.

**Mac says "cannot verify the developer"?** Normal, it just means it's not from the App
Store. **Right-click** the file → **Open** → **Open**. Once only.

**Windows shows a blue "Windows protected your PC" box?** Also normal. Click **More
info** → **Run anyway**.

---

## Step 4 ... add it to Chrome

1. Open Chrome, go to `chrome://extensions`
2. Turn on **Developer mode** (switch in the top-right corner)
3. Click **Load unpacked**
4. Pick the **`extension-beta`** folder inside the unzipped bundle ... the folder
   itself, don't open it and pick a file inside

---

## Step 5 ... quit Chrome properly, then turn it on

**This is the step everyone gets wrong.** Closing the window is not quitting.

- **Mac:** `Cmd` + `Q`. Then look at the Chrome icon in the dock ... if there's still a
  dot under it, it's still running.
- **Windows:** close every Chrome window.

Chrome only notices the helper when it starts up fresh. If it never actually stopped,
it never looks, and everything below will fail for no visible reason.

Now reopen Chrome:

1. Open the **Booking Bandit (Beta)** side panel
2. Sign in **with the coach's Google account**, not your own. This is on purpose: the
   drafts sound like the coach because they're built from the coach's profile. Your own
   login would produce generic ones.
3. Gear icon → **Settings** → **Key** tab → click **Test local engine**
4. **Green means done.**

You should already see a **Local** option, because the coach's account is already
switched on. If you don't, you signed in with the wrong Google account ... sign out and
try again with the coach's.

---

## Try it

Open Instagram or Facebook in Chrome, open a DM thread, open the side panel, and click
**Generate reply**. The first one takes 30-40 seconds because it's waking up Claude in
the background. After that it's quicker.

Nothing sends automatically. It writes a draft, you read it, you decide.

---

## When something acts up

**"It stopped working" / the panel does nothing** ... quit Chrome properly (`Cmd`+`Q`),
reopen. This fixes it the large majority of the time, including on a setup that worked
fine yesterday.

**A button seems dead** ... click it twice. Known quirk, being fixed.

**A voice note isn't included** ... click "view transcription" on the message first,
then "Read full thread."

**Panel shows a red error box** ... it has a **Copy diagnostics** button. Click it and
send that text to the coach.

**Anything else** ... screenshot it and send it to the coach.

To grab a screenshot on a Mac so it's ready to paste: `Cmd` + `Ctrl` + `Shift` + `4`,
then drag. (Plain `Cmd`+`Shift`+`4` saves it to your Desktop instead, which is why it
sometimes seems to vanish.)

---

## Worth knowing

You're using the coach's Claude subscription, so you both draw from the same monthly
allowance. If you're both generating heavily at once, one of you may see a "rate
limited" message. Wait a bit and try again.
