import type { App } from '../types';

/*
 * Desktop apps and their process names.
 *
 * Names are executable base names as the OS reports them:
 * - Windows: the image name with `.exe` (Task Manager «Details» tab).
 * - macOS: the bundle executable (`Foo.app/Contents/MacOS/<name>`), which may differ from
 *   the app name. The guardian also compares the name of the innermost `.app` bundle
 *   (guardian/internal/procwatch/matcher.go), so a bundle name such as `Minecraft`
 *   targets an app whose executable has a generic name.
 * - Linux: the base name of /proc/<pid>/exe or argv[0]. The guardian also compares
 *   /proc/<pid>/comm, which is cut to 15 bytes and is where Windows games run through
 *   Wine or Proton show their `.exe` name (`GTA5.exe`); only names of up to 15 bytes
 *   can match there.
 * Matching is case-insensitive on Windows and macOS and exact on Linux.
 *
 * Deliberate gaps:
 * - Generic executables are never listed, even when an app uses them: the macOS
 *   Minecraft launcher runs as `launcher` (its bundle `Minecraft` is listed instead),
 *   Minecraft: Java Edition as `javaw.exe`/`java`, Microsoft Store Roblox as
 *   `Windows10Universal.exe` and store apps such as Netflix inside `WWAHost.exe`.
 *   Killing those names would hit unrelated programs; the hosts file still cuts them off.
 * - Roblox Studio (`RobloxStudioBeta.exe`) and Minecraft Education are never closed: they
 *   are used to learn. While Roblox is blocked, Studio stays open but cannot sign in,
 *   update or publish, because it shares the player's hosts (see games.ts).
 * - Apps with no official build for a platform have an empty list there.
 */
export const APP_DATA: readonly App[] = [
  // Messaging.
  {
    id: 'discord',
    name: 'Discord',
    processes: {
      win: ['Discord.exe', 'DiscordPTB.exe', 'DiscordCanary.exe'],
      mac: ['Discord', 'Discord PTB', 'Discord Canary'],
      linux: ['Discord', 'discord', 'DiscordPTB', 'DiscordCanary'],
    },
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    processes: {
      // WhatsApp.Root.exe is the current Microsoft Store app.
      win: ['WhatsApp.exe', 'WhatsApp.Root.exe'],
      mac: ['WhatsApp'],
      linux: [],
    },
  },
  {
    id: 'telegram',
    name: 'Telegram',
    processes: {
      win: ['Telegram.exe'],
      mac: ['Telegram'],
      // Official tarball and Flatpak run `Telegram`; distro packages `telegram-desktop`.
      linux: ['Telegram', 'telegram-desktop'],
    },
  },
  // Games.
  {
    id: 'steam',
    name: 'Steam',
    processes: {
      win: ['steam.exe', 'steamwebhelper.exe'],
      mac: ['steam_osx', 'Steam Helper'],
      linux: ['steam', 'steamwebhelper'],
    },
  },
  {
    id: 'epic-games-launcher',
    name: 'Epic Games Launcher',
    processes: {
      win: ['EpicGamesLauncher.exe', 'EpicWebHelper.exe'],
      mac: ['EpicGamesLauncher', 'EpicGamesLauncher-Mac-Shipping', 'EpicWebHelper'],
      linux: [],
    },
  },
  {
    id: 'roblox',
    name: 'Roblox',
    processes: {
      win: ['RobloxPlayerBeta.exe', 'RobloxPlayerLauncher.exe'],
      mac: ['RobloxPlayer'],
      linux: [],
    },
  },
  {
    id: 'minecraft-launcher',
    name: 'Minecraft Launcher',
    processes: {
      // Minecraft.exe: Xbox/Microsoft Store launcher. Minecraft.Windows.exe: Bedrock.
      win: ['MinecraftLauncher.exe', 'Minecraft.exe', 'Minecraft.Windows.exe'],
      // Bundle name of /Applications/Minecraft.app, whose executable is `launcher`.
      mac: ['Minecraft'],
      linux: ['minecraft-launcher'],
    },
  },
  {
    id: 'fortnite',
    name: 'Fortnite',
    processes: {
      win: [
        'FortniteLauncher.exe',
        'FortniteClient-Win64-Shipping.exe',
        'FortniteClient-Win64-Shipping_EAC.exe',
        'FortniteClient-Win64-Shipping_EAC_EOS.exe',
        'FortniteClient-Win64-Shipping_BE.exe',
      ],
      mac: [],
      linux: [],
    },
  },
  {
    id: 'league-of-legends',
    name: 'League of Legends',
    processes: {
      win: [
        'LeagueClient.exe',
        'LeagueClientUx.exe',
        'LeagueClientUxRender.exe',
        'League of Legends.exe',
      ],
      mac: ['LeagueClient', 'LeagueClientUx', 'LeagueofLegends', 'League of Legends'],
      linux: [],
    },
  },
  {
    id: 'valorant',
    name: 'VALORANT',
    processes: {
      win: ['VALORANT.exe', 'VALORANT-Win64-Shipping.exe'],
      mac: [],
      linux: [],
    },
  },
  {
    id: 'riot-client',
    name: 'Riot Client',
    processes: {
      // Never add vgc.exe/vgk (Riot Vanguard): it is a kernel anti-cheat service.
      win: [
        'RiotClientServices.exe',
        'Riot Client.exe',
        'RiotClientUx.exe',
        'RiotClientUxRender.exe',
      ],
      mac: ['Riot Client', 'RiotClientServices'],
      linux: [],
    },
  },
  {
    id: 'battle-net',
    name: 'Battle.net',
    processes: {
      win: ['Battle.net.exe', 'Battle.net Launcher.exe'],
      mac: ['Battle.net'],
      linux: [],
    },
  },
  {
    id: 'ea-app',
    name: 'EA app',
    processes: {
      win: ['EADesktop.exe'],
      mac: [],
      linux: [],
    },
  },
  {
    id: 'ea-sports-fc',
    name: 'EA SPORTS FC',
    processes: {
      win: ['FC24.exe', 'FC25.exe', 'FC26.exe'],
      mac: [],
      linux: [],
    },
  },
  {
    id: 'ubisoft-connect',
    name: 'Ubisoft Connect',
    processes: {
      win: ['UbisoftConnect.exe', 'upc.exe'],
      mac: [],
      linux: [],
    },
  },
  {
    id: 'gog-galaxy',
    name: 'GOG Galaxy',
    processes: {
      win: ['GalaxyClient.exe'],
      mac: ['GOG Galaxy'],
      linux: [],
    },
  },
  {
    id: 'geforce-now',
    name: 'GeForce NOW',
    processes: {
      win: ['GeForceNOW.exe'],
      mac: ['GeForceNOW'],
      linux: [],
    },
  },
  {
    // Closing a launcher does not close a game that is already running, so the games
    // category also targets the most played PC games directly.
    id: 'popular-pc-games',
    name: 'Juegos de PC populares',
    processes: {
      win: [
        'cs2.exe',
        'dota2.exe',
        'RocketLeague.exe',
        'GTA5.exe',
        'GTA5_Enhanced.exe',
        'PlayGTAV.exe',
        'r5apex.exe',
        'r5apex_dx12.exe',
        'Overwatch.exe',
        'GenshinImpact.exe',
        'Among Us.exe',
        'FallGuys_client_game.exe',
        'Terraria.exe',
        'Stardew Valley.exe',
        'GeometryDash.exe',
        'Brawlhalla.exe',
        'RainbowSix.exe',
        'RainbowSix_BE.exe',
        'cod.exe',
      ],
      mac: [],
      // Native builds, then Proton/Wine games by their comm (Windows names up to 15 bytes).
      linux: [
        'cs2',
        'dota2',
        'GTA5.exe',
        'PlayGTAV.exe',
        'Overwatch.exe',
        'Among Us.exe',
        'Terraria.exe',
        'Brawlhalla.exe',
      ],
    },
  },
  // Opt-in.
  {
    id: 'spotify',
    name: 'Spotify',
    processes: {
      win: ['Spotify.exe'],
      mac: ['Spotify'],
      linux: ['spotify'],
    },
  },
];
