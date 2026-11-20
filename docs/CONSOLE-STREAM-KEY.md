# Console profiles: your Twitch stream key

A PS5 / Xbox / Switch streams to Twitch using your **Twitch stream key**.
CastNexus captures that broadcast, either on your LAN or through the
[VPS console gateway](VPS-CONSOLE-GATEWAY.md). It then knows the stream is
yours by matching the key. So every account that uses a **Console profile**
needs its stream key saved in CastNexus.

There are two ways to provide it. You can use either one, and switch between
them at any time.

| | **Import from Twitch (OAuth2)**, recommended | **Enter it manually** |
| --- | --- | --- |
| How | Click a button, approve on Twitch | Copy the key from the Twitch dashboard and paste it |
| Typos / old keys | Impossible: Twitch sends the current key | Possible |
| Twitch permission | *View your stream key* (`channel:read:stream_key`), used once | None |
| Needs | An oauth-broker with stream key support (see below) | Nothing |

## Where you are asked

- **First sign-in.** When you pick *Console Streaming* as your first profile,
  the **Add your Twitch stream key** screen offers **Import from Twitch
  (OAuth2)**, or a box to paste it manually.
- **Creating or editing a Console profile.** Profiles → *New Console profile*
  (or ✎ on an existing one) has a **Twitch stream key** section:
  - **Keep the saved key**: shown masked, with whether it was imported or
    typed. Only appears once a key is saved.
  - **Import it from Twitch with OAuth2**
  - **Enter it manually**
- **Later.** Sources → Console → **Change stream key**. Use this if you reset
  your key on Twitch.

## Option 1: Import from Twitch (OAuth2)

1. Choose **Import it from Twitch with OAuth2** and save, or click **Import from
   Twitch (OAuth2)**.
2. A CastNexus page opens the Twitch authorization in a new window.
   - Twitch asks you to allow **"View your stream key"**.
   - Twitch always shows this prompt, so you can check which Twitch account
     you're approving.
3. Approve. The CastNexus page finishes by itself and returns you to the Studio
   with *"Twitch stream key imported"*.

What happens behind the scenes:

- **The broker reads the key once.** The oauth-broker asks Twitch for
  `channel:read:stream_key` and reads the key once
  (`GET helix/streams/key`). It then **revokes that Twitch token straight
  away**.
- **Only the key comes back.** Your CastNexus install receives just the key and
  your Twitch user id. No Twitch token is stored anywhere.
- **It must be your own key.** CastNexus only saves the key if it belongs to
  the Twitch account you're signed in with. If you approve on Twitch as a
  different account, it refuses:
  *"You authorised the Twitch account X, but you are signed in to CastNexus as Y"*.
- **Masked after saving.** The key is shown masked (`live••••cdef`) and never
  shown in full again.

### Broker requirement

Stream key import needs an oauth-broker that supports `purpose: "stream_key"`.
The official broker at `https://castnexus.nekosunevr.co.uk/oauth` gets this
once it's updated.

If you run **your own** broker, update it to the current `oauth-broker` branch.
You don't need to change your Twitch application: the scope is requested at
authorization time.

With an older broker, CastNexus shows *"The OAuth broker did not return a
stream key … enter the key manually, or update the oauth-broker"*. Manual entry
always works.

## Option 2: Enter it manually

1. Open the [Twitch Creator Dashboard](https://dashboard.twitch.tv/) →
   **Settings → Stream → Primary Stream key**, and click **Copy**.
2. In CastNexus, choose **Enter it manually**, paste the key (it starts with
   `live_`) and save.

## After you reset your key on Twitch

Twitch invalidates the old key when you reset it. The console starts using the
new key, so CastNexus has to be updated too:
- **Sources → Console → Change stream key → Import it from Twitch with OAuth2**, or
- paste the new key manually.

Until then, CastNexus won't recognise the console's broadcast as yours.

## Turning console support off

With `CASTNEXUS_CONSOLE_STREAMING=false`:
- Console profiles and every stream-key screen are hidden.
- `/auth/twitch/stream-key` is refused.

See [ADVANCED-CONFIGURATION.md](ADVANCED-CONFIGURATION.md) and `.env.example`.

## Troubleshooting

| Message | Fix |
| --- | --- |
| *You authorised the Twitch account "X", but you are signed in to CastNexus as "Y"* | In the Twitch window, log out and log in as Y, then import again. |
| *The OAuth broker did not return a stream key* | The broker is older than this feature. Update it, or enter the key manually. |
| *Your CastNexus session ended* | Sign in to the Studio again, then import. |
| Console broadcast isn't detected | Make sure the active profile is a Console profile and the saved key is the current one. Import it again after any reset on Twitch. |
