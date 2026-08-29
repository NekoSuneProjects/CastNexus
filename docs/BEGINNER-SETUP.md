# CastNexus Beginner Setup Guide

This guide is for people who have **never used Docker before** and just want to get CastNexus running without guessing what commands to use.

If you only want normal **PC / OBS streaming** or **Music 24/7**, follow the **Basic setup** section. You do **not** need the console interception containers.

> [!IMPORTANT]
> For the easiest and most reliable setup, use a 64-bit Linux machine such as Ubuntu, Debian, or Raspberry Pi OS 64-bit. Raspberry Pi 4/5 is supported, but a Pi 5 is strongly preferred for heavier scenes/transcoding.

---

## What CastNexus does

CastNexus is a self-hosted broadcast control system. It can receive a stream from OBS or another source, apply CastNexus profiles/scenes, and send the stream to one or more destinations.

The normal Docker stack includes:

- CastNexus Studio web dashboard
- MediaMTX RTMP/RTSP/HLS/WebRTC/SRT server
- FFmpeg processing inside the dashboard image
- Music 24/7 worker
- VRChat-compatible HLS relay
- hosted OAuth support so most users do not need to create Twitch/Google developer apps

Optional console mode also starts:

- CastNexus DNS helper
- CastNexus network interception helper

---

# 1. Pick the setup you need

## Basic PC / OBS / Music setup — recommended for beginners

Use this if you want:

- OBS or Streamlabs -> CastNexus
- Twitch / YouTube / Kick / custom outputs
- Music 24/7
- VOD/rerun features
- browser overlays
- VRChat playback links

Start command:

```bash
docker compose up -d
```

## Console capture on your home network — advanced

Use this only when you specifically want CastNexus to intercept a supported console Twitch broadcast on your LAN.

Start command:

```bash
docker compose --profile console up -d
```

Console interception needs a **real Linux host** for the full networking features. Docker Desktop on Windows/macOS can run the normal stack, but its host networking is not equivalent to Linux for the layer-2 interception used by LAN console mode.

## VPS/public console gateway — advanced

See:

[`docs/VPS-CONSOLE-GATEWAY.md`](VPS-CONSOLE-GATEWAY.md)

Do not start with VPS console mode unless you already understand public IPs, firewall rules and DNS.

---

# 2. What you need

For the recommended Linux install you need:

- a 64-bit Linux computer/server/Raspberry Pi
- an internet connection
- Git
- Docker Engine
- Docker Compose v2 (`docker compose`, with a space)
- the local IP address of the CastNexus machine

You do **not** normally need:

- Node.js
- npm
- FFmpeg installed on the host
- Chromium installed on the host
- a Twitch developer application
- a Google developer application

The Docker images already contain the application dependencies used by the normal Docker deployment.

---

# 3. Install Git

Ubuntu / Debian / Raspberry Pi OS:

```bash
sudo apt update
sudo apt install -y git curl
```

Check it:

```bash
git --version
```

---

# 4. Install Docker

## Easy Linux install

Docker provides an official convenience installer. It is useful for home/self-hosted installs and testing:

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
```

Then verify Docker:

```bash
sudo docker run --rm hello-world
```

Check Docker Compose:

```bash
docker compose version
```

If `docker compose` says permission denied, either use `sudo docker ...` temporarily or add your account to the Docker group:

```bash
sudo usermod -aG docker "$USER"
```

Then **sign out and sign back in** before trying again.

Official Docker installation documentation:

- Ubuntu: <https://docs.docker.com/engine/install/ubuntu/>
- Debian: <https://docs.docker.com/engine/install/debian/>
- Raspberry Pi OS: <https://docs.docker.com/engine/install/raspberry-pi-os/>
- Docker Compose plugin: <https://docs.docker.com/compose/install/linux/>

> [!NOTE]
> Raspberry Pi OS 64-bit should follow the Debian/ARM64 Docker packages. Avoid old 32-bit Pi images for a new CastNexus install.

---

# 5. Download CastNexus

Choose a folder where you want CastNexus to live, then run:

```bash
git clone https://github.com/NekoSuneProjects/CastNexus.git
cd CastNexus
```

You should now be inside the CastNexus folder.

Check with:

```bash
pwd
ls
```

You should see files such as:

```text
docker-compose.yml
.env.example
install.sh
dashboard/
config/
```

---

# 6. Find the IP address of the CastNexus machine

Run:

```bash
hostname -I
```

Example output:

```text
192.168.1.50
```

Use the normal LAN address that other devices in your house can reach.

Do not use:

- `127.0.0.1`
- `localhost`
- a Docker bridge address such as `172.17.x.x`
- a Tailscale/VPN address unless that is intentionally how you want clients to reach CastNexus

If several addresses are shown, this command usually shows the first one:

```bash
hostname -I | awk '{print $1}'
```

---

# 7. Create your CastNexus configuration

Copy the example environment file:

```bash
cp .env.example .env
```

Open it:

```bash
nano .env
```

For a normal beginner install, the important setting is:

```dotenv
PI_IP=192.168.1.50
```

Replace `192.168.1.50` with the IP you found in the previous step.

For normal PC/Music use, keep these blank:

```dotenv
TARGET_IPS=
GATEWAY_IP=
```

Keep the hosted OAuth broker enabled unless you deliberately want to use your own Twitch/Google developer credentials:

```dotenv
CASTNEXUS_OAUTH_BROKER_URL=https://castnexus.nekosunevr.co.uk/oauth
```

The Twitch/YouTube client ID and secret fields may remain empty when you are using the hosted OAuth broker.

Save in Nano:

1. press `Ctrl+O`
2. press `Enter`
3. press `Ctrl+X`

---

# 8. Start CastNexus

## Recommended manual command

Pull the current stable images:

```bash
docker compose pull
```

Start CastNexus:

```bash
docker compose up -d
```

`-d` means the containers stay running in the background after you close the terminal.

## Or use the included helper

After `.env` has been configured:

```bash
chmod +x install.sh
./install.sh
```

The helper pulls the images and starts the correct normal/console profile based on your configuration.

---

# 9. Check that it started correctly

Run:

```bash
docker compose ps
```

For a normal install you should see the main services running, including:

- `castnexus-dashboard`
- `castnexus-mediamtx`
- `castnexus-mediamtx-vrchat`
- `castnexus-vrchat-relay`

Check Studio logs:

```bash
docker compose logs --tail=100 dashboard
```

Follow live logs:

```bash
docker compose logs -f dashboard
```

Press `Ctrl+C` to stop watching logs. This does **not** stop CastNexus.

---

# 10. Open CastNexus Studio

On a computer/phone connected to the same network, open:

```text
http://YOUR_CASTNEXUS_IP:8090
```

Example:

```text
http://192.168.1.50:8090
```

Useful pages:

```text
Homepage: http://YOUR_CASTNEXUS_IP:8090/
Login:    http://YOUR_CASTNEXUS_IP:8090/login
Studio:   http://YOUR_CASTNEXUS_IP:8090/dashboard
```

Sign in and finish the CastNexus setup inside the web UI.

---

# 11. First PC / OBS setup

After signing in:

1. create or select a **PC Streaming** profile
2. open **Sources**
3. copy the CastNexus RTMP server
4. copy the CastNexus-generated PC stream key
5. open OBS
6. go to **Settings -> Stream**
7. choose **Custom** service
8. paste the CastNexus RTMP server
9. paste the CastNexus key
10. add the destinations you want inside CastNexus
11. start streaming from OBS

The CastNexus key is separate from your real Twitch stream key.

---

# 12. Music 24/7 setup

1. sign in to CastNexus
2. create a **24/7 Music** profile
3. open **Music / 24/7**
4. upload your music
5. configure shuffle/loop/volume
6. configure the scene
7. enable your output destinations
8. start the music profile

Music 24/7 runs inside the dashboard container. There is no separate `music24` Docker service that you need to start.

---

# 13. Optional home console capture

Skip this entire section if you only use OBS/PC/Music.

You need:

- CastNexus running on a Linux host
- the console's LAN IP address
- your router/gateway IP address

Find your router/gateway on Linux:

```bash
ip route | awk '/default/ {print $3; exit}'
```

Example:

```text
192.168.1.1
```

Find the console IP from the console network screen or your router's connected-device list.

Edit `.env`:

```bash
nano .env
```

Example:

```dotenv
PI_IP=192.168.1.50
TARGET_IPS=192.168.1.100
GATEWAY_IP=192.168.1.1
INTERCEPT_MODE=lan
```

Then start the console profile:

```bash
docker compose --profile console pull
docker compose --profile console up -d
```

Check it:

```bash
docker compose --profile console ps
```

Watch DNS logs:

```bash
docker compose logs -f dns
```

Watch interception logs:

```bash
docker compose logs -f intercept
```

Set the console's **Primary DNS** to the CastNexus machine IP.

Example:

```text
Primary DNS:   192.168.1.50
Secondary DNS: leave blank, or 0.0.0.0 if the console requires a value
```

Then use a Console Streaming profile in CastNexus Studio.

> [!WARNING]
> The console helper uses host networking plus `NET_ADMIN` / `NET_RAW`. Only enable it when you need console capture and only on a network you control.

---

# 14. Updating CastNexus later

From the CastNexus folder:

```bash
git pull
```

For stable Docker images:

```bash
docker compose pull
docker compose up -d
```

If you use console mode:

```bash
docker compose --profile console pull
docker compose --profile console up -d
```

Your persistent Studio data is stored in the repository's mounted `dashboard/data` directory, so normal container replacement does not wipe it.

---

# 15. Stop or restart CastNexus

Restart:

```bash
docker compose restart
```

Stop and remove the running containers without deleting your bind-mounted data:

```bash
docker compose down
```

Start again:

```bash
docker compose up -d
```

For console mode, add `--profile console` when starting it again.

---

# 16. Important ports

Because CastNexus uses Docker host networking, make sure these ports are not already occupied when the related feature is running.

| Port | Protocol | Used for |
|---|---|---|
| `8090` | TCP | CastNexus Studio |
| `1935` | TCP | RTMP ingest |
| `8554` | TCP/UDP | RTSP |
| `8888` | TCP | HLS |
| `8889` | TCP/UDP | WebRTC/WHEP |
| `8890` | UDP | SRT |
| `8898` | TCP | VRChat-compatible HLS |
| `53` | TCP/UDP | CastNexus DNS, console profile only |

Do not expose every port to the public internet unless you understand why it is needed.

---

# 17. Common problems

## `docker: command not found`

Docker is not installed or your shell has not picked it up yet.

Check:

```bash
docker --version
```

Then follow the Docker installation section above.

---

## `docker compose` does not work

Check:

```bash
docker compose version
```

On Ubuntu/Debian with Docker's official repository, install the Compose plugin with:

```bash
sudo apt update
sudo apt install docker-compose-plugin
```

Use modern Compose commands:

```text
docker compose
```

not the old standalone command:

```text
docker-compose
```

---

## Permission denied connecting to `/var/run/docker.sock`

Either run Docker with `sudo`, or add your user to the Docker group:

```bash
sudo usermod -aG docker "$USER"
```

Then sign out and sign back in.

Do **not** fix Docker permissions with commands such as `chmod 666 /var/run/docker.sock`.

---

## CastNexus page does not open

Check the containers:

```bash
docker compose ps
```

Check Studio logs:

```bash
docker compose logs --tail=200 dashboard
```

Check whether port 8090 is listening:

```bash
sudo ss -lntp | grep ':8090'
```

Make sure the IP in `.env` is the real LAN IP of the CastNexus machine.

---

## `address already in use`

Find which program is already using the port.

Example for Studio:

```bash
sudo ss -lntup | grep ':8090'
```

Example for RTMP:

```bash
sudo ss -lntup | grep ':1935'
```

Stop/reconfigure the conflicting application or change the relevant CastNexus setting where supported.

---

## Console DNS container cannot bind port 53

Check what is using port 53:

```bash
sudo ss -lntup | grep ':53 '
```

Ubuntu/Debian systems may show `systemd-resolved` on `127.0.0.53:53`.

Do not randomly kill DNS services on a remote server. If port 53 needs to be freed, first understand how that host resolves DNS and make sure `/etc/resolv.conf` will still point to a working resolver.

For console mode, the CastNexus DNS container must be able to listen on the required DNS port.

---

## Containers keep restarting

Show recent logs from every service:

```bash
docker compose logs --tail=200
```

Show only the dashboard:

```bash
docker compose logs --tail=200 dashboard
```

Show MediaMTX:

```bash
docker compose logs --tail=200 mediamtx
```

For console mode:

```bash
docker compose logs --tail=200 dns intercept
```

When asking for help, send the relevant log output rather than only saying "it does not work".

> [!CAUTION]
> Before posting logs publicly, remove stream keys, OAuth tokens, passwords, cookies, private IP information you do not want to share, and any other secrets.

---

# 18. NVIDIA GPU acceleration

GPU acceleration is optional. CastNexus falls back to CPU encoding when no supported GPU encoder is available.

For NVIDIA Docker acceleration, install NVIDIA Container Toolkit first, then use the provided Compose overlay:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.gpu-nvidia.yml \
  up -d
```

See the comments inside [`docker-compose.gpu-nvidia.yml`](../docker-compose.gpu-nvidia.yml).

If you are a beginner, get the normal CPU Docker setup working first before adding GPU passthrough.

---

# 19. Windows Docker Desktop

For basic testing on Windows:

1. install Docker Desktop
2. use Linux containers
3. use Docker Desktop 4.34 or newer
4. enable **Host networking** in Docker Desktop settings
5. clone CastNexus
6. create `.env`
7. run `docker compose up -d`

Docker documentation:

- <https://docs.docker.com/desktop/setup/install/windows-install/>
- <https://docs.docker.com/engine/network/drivers/host/>

Full LAN console interception is intended for a real Linux host because Docker Desktop's host networking only exposes higher-level TCP/UDP networking and does not provide the same low-level host network behavior as Docker Engine on Linux.

---

# 20. Raspberry Pi notes

Raspberry Pi 5 with Raspberry Pi OS 64-bit is the recommended Pi setup.

CastNexus has safe-render settings for smaller/CPU-only hosts. The defaults can automatically reduce compositor load.

If a heavy scene causes the Pi to fall behind, `.env.example` contains lower-resolution CPU/Pi safe-mode settings you can enable.

Check temperature:

```bash
vcgencmd measure_temp
```

Check CPU/RAM:

```bash
top
```

Check Docker usage:

```bash
docker stats
```

---

# 21. The shortest possible Linux setup

If Docker and Git are already installed, the normal beginner install is simply:

```bash
git clone https://github.com/NekoSuneProjects/CastNexus.git
cd CastNexus
cp .env.example .env
hostname -I
nano .env
```

Set:

```dotenv
PI_IP=YOUR_LAN_IP
TARGET_IPS=
GATEWAY_IP=
```

Then:

```bash
docker compose pull
docker compose up -d
docker compose ps
```

Open:

```text
http://YOUR_LAN_IP:8090
```

That is all you need for the normal PC / OBS / Music CastNexus setup.

---

## More documentation

- Main project README: [`../README.md`](../README.md)
- General installation choices: [`../INSTALL.md`](../INSTALL.md)
- Hosted OAuth: [`HOSTED-OAUTH.md`](HOSTED-OAUTH.md)
- VPS console gateway: [`VPS-CONSOLE-GATEWAY.md`](VPS-CONSOLE-GATEWAY.md)
- VRChat HLS: [`HLS-VRCHAT.md`](HLS-VRCHAT.md)
- GPU / Twitch recordings / YouTube: [`GPU-TWITCH-RECORDINGS-YOUTUBE.md`](GPU-TWITCH-RECORDINGS-YOUTUBE.md)
- VOD/reruns: [`VOD-RERUNS.md`](VOD-RERUNS.md)
