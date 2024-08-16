import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";
import { retry } from "@octokit/plugin-retry";
import YAML from 'yaml'
import * as fs from "fs";
import { exit } from "process";
import semver from 'semver';

const args = process.argv.slice(2);
let lintMode = false;
if (args.length !== 0) {
    lintMode = args[0] === "lint";
    console.log("lint mode enabled");
}

let octokit = undefined;
if (!lintMode) {
    Octokit.plugin(throttling);
    Octokit.plugin(retry);
    octokit = new Octokit({
        auth: process.env.GITHUB_TOKEN,
        userAgent: "OpenGOAL-Mods/jakmods.dev",
        log: {
            debug: () => { },
            info: () => { },
            warn: console.warn,
            error: console.error,
        },
        throttle: {
            onRateLimit: (retryAfter, options) => {
                octokit.log.warn(
                    `Request quota exhausted for request ${options.method} ${options.url}`,
                );
                if (options.request.retryCount <= 2) {
                    console.log(`Retrying after ${retryAfter} seconds!`);
                    return true;
                }
            },
            onAbuseLimit: (retryAfter, options) => {
                octokit.log.warn(
                    `Abuse detected for request ${options.method} ${options.url}`,
                );
            },
        },
    });
}

function exitWithError(errorMessage) {
    console.error(errorMessage);
    exit(1);
}

function validateJsonKeys(keysToCheck, keys, messagePrefix) {
    for (const key of keysToCheck) {
        if (!keys.includes(key)) {
            console.error(`${messagePrefix}: missing ${key}`)
            return false;
        }
    }
    return true;
}

// Retrieve the configuration so we know what to look for
if (!fs.existsSync("./config.yaml")) {
    exitWithError("Couldn't locate 'config.yaml' file, aborting!");
}

// Parse it
let configFile;
try {
    configFile = YAML.parse(fs.readFileSync("./config.yaml").toString())
} catch (e) {
    exitWithError(`Couldn't successfully parse config file, fix it!: ${e}`);
}

// Validate config file metadata
if (!configFile["metadata"]["name"]) {
    exitWithError(`'metadata' section missing schema_version or name`);
}

let modSourceData = {
    schemaVersion: "1.0.0",
    sourceName: configFile["metadata"]["name"],
    mods: {},
    texturePacks: {}
}

// Now we can start generating the actual mod-source file
if (!configFile["mods"]) {
    exitWithError(`'mods' section missing`);
}
// iterate through all listed repos and build up the file
for (const [modName, modInfo] of Object.entries(configFile["mods"])) {
    // Iterate through the releases
    // - check that we shouldn't ignore it
    // - if the assets have a `metadata.json` file, we download and inspect it for a handful of settings (potentially used more in the future)
    if (!validateJsonKeys(["display_name", "description", "authors", "tags", "supported_games"], Object.keys(modInfo), `${modName}`)) {
        exitWithError("aborting");
    }
    let modSourceInfo = {
        displayName: modInfo["display_name"],
        description: modInfo["description"],
        authors: modInfo["authors"],
        tags: modInfo["tags"],
        supportedGames: modInfo["supported_games"],
        websiteUrl: modInfo["website_url"],
        versions: [],
        coverArtUrl: undefined,
        thumbnailArtUrl: undefined,
        releaseDate: undefined,
        perGameConfig: null,
        externalLink: null
    };
    if (!Object.keys(modInfo).includes("website_url")) {
        // either its an external link and we can ignore it
        // or we infer it from the repo_owner_name
        if (!Object.keys(modInfo).includes("external_link")) {
            modSourceInfo.websiteUrl = `https://www.github.com/${modInfo["repo_owner"]}/${modInfo["repo_name"]}`;
        }
    }
    if (Object.keys(modInfo).includes("cover_art_url")) {
        modSourceInfo.coverArtUrl = modInfo["cover_art_url"];
    }
    if (Object.keys(modInfo).includes("thumbnail_art_url")) {
        modSourceInfo.thumbnailArtUrl = modInfo["thumbnail_art_url"];
    }
    if (Object.keys(modInfo).includes("release_date_override")) {
        modSourceInfo.releaseDate = modInfo["release_date_override"];
    }
    if (Object.keys(modInfo).includes("per_game_config")) {
        modSourceInfo.perGameConfig = {};
        // iterate per-game configs
        for (const [game, perGameConfig] of Object.entries(modInfo["per_game_config"])) {
            modSourceInfo.perGameConfig[game] = {};
            if (Object.keys(perGameConfig).includes("cover_art_url")) {
                modSourceInfo.perGameConfig[game].coverArtUrl = perGameConfig["cover_art_url"];
            }
            if (Object.keys(perGameConfig).includes("thumbnail_art_url")) {
                modSourceInfo.perGameConfig[game].thumbnailArtUrl = perGameConfig["thumbnail_art_url"];
            }
        }
    }
    // lint the per-game-config
    if (modSourceInfo.coverArtUrl === undefined) {
        if (!Object.keys(modInfo).includes("per_game_config")) {
            exitWithError(`${modName} does not define 'cover_art_url' but lacks 'per_game_config'`)
        }
        // Check per game config
        for (const supportedGame of modSourceInfo.supportedGames) {
            if (!Object.keys(modSourceInfo.perGameConfig).includes(supportedGame) || !Object.keys(modSourceInfo.perGameConfig[supportedGame]).includes("coverArtUrl")) {
                exitWithError(`${modName} does not define 'cover_art_url' and it's missing in 'per_game_config.${supportedGame}'`);
            }
        }
    }
    if (modSourceInfo.thumbnailArtUrl === undefined) {
        if (!Object.keys(modInfo).includes("per_game_config")) {
            exitWithError(`${modName} does not define 'thumbnail_art_url' but lacks 'per_game_config'`)
        }
        // Check per game config
        for (const supportedGame of modSourceInfo.supportedGames) {
            if (!Object.keys(modSourceInfo.perGameConfig).includes(supportedGame) || !Object.keys(modSourceInfo.perGameConfig[supportedGame]).includes("thumbnailArtUrl")) {
                exitWithError(`${modName} does not define 'thumbnail_art_url' and it's missing in 'per_game_config.${supportedGame}'`);
            }
        }
    }

    // if the mod is external only, we don't check releases
    if (Object.keys(modInfo).includes("external_link")) {
        modSourceInfo.externalLink = modInfo["external_link"];
        modSourceData.mods[modName] = modSourceInfo;
        continue;
    }
    // otherwise, we poll github
    if (!modInfo["repo_owner"] || !modInfo["repo_name"]) {
        exitWithError(`'repo_owner' or 'repo_name' missing in: ${modName}`);
    }
    if (!lintMode) {
        const modReleases = await octokit.paginate(octokit.rest.repos.listReleases, { owner: modInfo["repo_owner"], repo: modInfo["repo_name"] });

        if (modSourceInfo.release === undefined && modReleases.length > 0) {
            modSourceInfo.release = modReleases[0].published_at;
        }

        for (const release of modReleases) {
            let cleaned_release_tag = release.tag_name;
            if (cleaned_release_tag.startsWith("v")) {
                cleaned_release_tag = cleaned_release_tag.substring(1);
            }
            if (!semver.valid(cleaned_release_tag)) {
                console.error(`${modName}:${cleaned_release_tag} is not a valid semantic version, skipping`);
                continue;
            }
            // Check that we shouldn't ignore it
            if (Object.keys(modInfo).includes("ignore_versions")) {
                let skipIt = false;
                for (const ignore_version of modInfo["ignore_versions"]) {
                    if (ignore_version.startsWith("<")) {
                        let cleaned_ignore_version = ignore_version.substring(1);
                        if (semver.lt(cleaned_release_tag, cleaned_ignore_version)) {
                            console.log(`ignoring release - ${modName}:${cleaned_release_tag}`);
                            skipIt = true;
                            break;
                        }
                    } else if (semver.eq(ignore_version, cleaned_release_tag)) {
                        console.log(`ignoring release - ${modName}:${ignore_version}`);
                        skipIt = true;
                        break;
                    }
                }
                if (skipIt) {
                    continue;
                }
                // otherwise, we ain't skipping it...yet
                let newVersion = {
                    version: cleaned_release_tag,
                    publishedDate: release.published_at,
                    supportedGames: [],
                    settings: {
                        decompConfigOverride: "",
                        shareVanillaSaves: false,
                    },
                    assets: {
                        windows: null,
                        linux: null,
                        macos: null
                    },
                    assetDownloadCounts: {
                        windows: 0,
                        linux: 0,
                        macos: 0
                    }
                }
                // get the assets
                let metadataFileUrl = null;
                for (const asset of release.assets) {
                    if (asset.name.toLowerCase().startsWith("windows-")) {
                        newVersion.assets.windows = asset.browser_download_url;
                        newVersion.assetDownloadCounts.windows = asset.download_count;
                    } else if (asset.name.toLowerCase().startsWith("linux-")) {
                        newVersion.assets.linux = asset.browser_download_url;
                        newVersion.assetDownloadCounts.linux = asset.download_count;
                    } else if (asset.name.toLowerCase().startsWith("macos-")) {
                        newVersion.assets.macos = asset.browser_download_url;
                        newVersion.assetDownloadCounts.macos = asset.download_count;
                    } else if (asset.name.toLowerCase() === "metadata.json") {
                        metadataFileUrl = asset.browser_download_url;
                    }
                }
                if (metadataFileUrl !== null) {
                    const metadataResp = await fetch(metadataFileUrl);
                    if (metadataResp.status === 200) {
                        try {
                            const data = JSON.parse(await metadataResp.text());
                            if (Object.keys(data).includes("settings")) {
                                newVersion.settings = data.settings;
                            }
                            if (!Object.keys(data).includes("supportedGames")) {
                                exitWithError(`metadata.json, for version: ${modName}:${cleaned_release_tag} does not include 'supportedGames'`)
                            } else {
                                newVersion.supportedGames = data.supportedGames;
                            }
                        } catch (e) {
                            exitWithError(`Bad metadata.json, not valid JSON: ${e} -- ${modName}:${cleaned_release_tag}`)
                        }
                    } else {
                        exitWithError(`Hit non-200 status code when fetching metadata file for mod release version ${modName}:${cleaned_release_tag}`);
                    }
                }

                // If there are no assets, skip it -- there's nothing to download!
                if (newVersion.assets.windows === null && newVersion.assets.linux === null && newVersion.assets.macos === null) {
                    console.log(`ignoring version, no assets found - ${modName}:${cleaned_release_tag}`);
                    continue;
                }
                // otherwise, add it to the list
                modSourceInfo.versions.push(newVersion);
            }
        }
    }

    // add to source json
    modSourceData.mods[modName] = modSourceInfo;
}

if (!configFile["texture_packs"]) {
    exitWithError(`'texture_packs' section missing`);
}

// Do the same with texture packs
// TODO - lots of duplication, de-duplicate it if you care
// iterate through all listed repos and build up the file
for (const [modName, modInfo] of Object.entries(configFile["texture_packs"])) {
    // Iterate through the releases
    // - check that we shouldn't ignore it
    // - if the assets have a `metadata.json` file, we download and inspect it for a handful of settings (potentially used more in the future)
    if (!validateJsonKeys(["display_name", "description", "authors", "tags", "supported_games"], Object.keys(modInfo), `${modName}`)) {
        exitWithError("aborting");
    }
    let modSourceInfo = {
        displayName: modInfo["display_name"],
        description: modInfo["description"],
        authors: modInfo["authors"],
        tags: modInfo["tags"],
        supportedGames: modInfo["supported_games"],
        websiteUrl: modInfo["website_url"],
        versions: [],
        thumbnailArtUrl: undefined,
        releaseDate: undefined,
        perGameConfig: null,
    };
    if (!Object.keys(modInfo).includes("website_url")) {
        // either its an external link and we can ignore it
        // or we infer it from the repo_owner_name
        if (!Object.keys(modInfo).includes("external_link")) {
            modSourceInfo.websiteUrl = `https://www.github.com/${modInfo["repo_owner"]}/${modInfo["repo_name"]}`;
        }
    }
    if (Object.keys(modInfo).includes("thumbnail_art_url")) {
        modSourceInfo.thumbnailArtUrl = modInfo["thumbnail_art_url"];
    }
    if (Object.keys(modInfo).includes("release_date_override")) {
        modSourceInfo.releaseDate = modInfo["release_date_override"];
    }
    if (Object.keys(modInfo).includes("per_game_config")) {
        modSourceInfo.perGameConfig = modInfo["per_game_config"];
    }
    // lint the per-game-config
    if (modSourceInfo.thumbnailArtUrl === undefined) {
        if (!Object.keys(modInfo).includes("per_game_config")) {
            exitWithError(`${modName} does not define 'thumbnail_art_url' but lacks 'per_game_config'`)
        }
        // Check per game config
        for (const supportedGame of modSourceInfo.supportedGames) {
            if (!Object.keys(modSourceInfo.perGameConfig).includes(supportedGame) || !Object.keys(modSourceInfo.perGameConfig[supportedGame]).includes("thumbnailArtUrl")) {
                exitWithError(`${modName} does not define 'thumbnail_art_url' and it's missing in 'per_game_config.${supportedGame}'`);
            }
        }
    }
    // otherwise, we poll github
    if (!modInfo["repo_owner"] || !modInfo["repo_name"]) {
        exitWithError(`'repo_owner' or 'repo_name' missing in: ${modName}`);
    }
    if (!lintMode) {
        const modReleases = await octokit.paginate(octokit.rest.repos.listReleases, { owner: modInfo["repo_owner"], repo: modInfo["repo_name"] });

        if (modSourceInfo.release === undefined && modReleases.length > 0) {
            modSourceInfo.release = modReleases[0].published_at;
        }

        for (const release of modReleases) {
            let cleaned_release_tag = release.tag_name;
            if (cleaned_release_tag.startsWith("v")) {
                cleaned_release_tag = cleaned_release_tag.substring(1);
            }
            if (!semver.valid(cleaned_release_tag)) {
                console.error(`${modName}:${cleaned_release_tag} is not a valid semantic version, skipping`);
                continue;
            }
            // Check that we shouldn't ignore it
            if (Object.keys(modInfo).includes("ignore_versions")) {
                let skipIt = false;
                for (const ignore_version of modInfo["ignore_versions"]) {
                    if (ignore_version.startsWith("<")) {
                        let cleaned_ignore_version = ignore_version.substring(1);
                        if (semver.lt(cleaned_release_tag, cleaned_ignore_version)) {
                            console.log(`ignoring release - ${modName}:${cleaned_release_tag}`);
                            skipIt = true;
                            break;
                        }
                    } else if (semver.eq(ignore_version, cleaned_release_tag)) {
                        console.log(`ignoring release - ${modName}:${ignore_version}`);
                        skipIt = true;
                        break;
                    }
                }
                if (skipIt) {
                    continue;
                }
                // otherwise, we ain't skipping it...yet
                let newVersion = {
                    version: cleaned_release_tag,
                    publishedDate: release.published_at,
                    downloadUrl: null,
                    downloadCount: 0
                }
                // get the assets
                for (const asset of release.assets) {
                    if (asset.name.toLowerCase() === "assets.zip") {
                        newVersion.downloadUrl = asset.browser_download_url;
                        newVersion.downloadCount = asset.download_count;
                    }
                }
                // If there are no assets, skip it -- there's nothing to download!
                if (newVersion.assets.downloadUrl === null) {
                    console.log(`ignoring version, no assets.zip found - ${modName}:${cleaned_release_tag}`);
                    continue;
                }
                // otherwise, add it to the list
                modSourceInfo.versions.push(newVersion);
            }
        }
    }
    // add to source json
    modSourceData.texturePacks[modName] = modSourceInfo;
}

if (!lintMode) {
    // Check if the resulting file is different from the existing one (minus lastUpdated)
    if (fs.existsSync("../../site/mods.json")) {
        let existingModSourceData = JSON.parse(fs.readFileSync("../../site/mods.json"));
        delete existingModSourceData["lastUpdated"];
        // if it is, copy it over,
        if (JSON.stringify(existingModSourceData) === JSON.stringify(modSourceData)) {
            console.log("mods.json would be unchanged, not updating the file");
        } else { // if not, do nothing!
            modSourceData.lastUpdated = (new Date()).toISOString();
            // Save the json file out
            fs.writeFileSync("../../site/mods.json", JSON.stringify(modSourceData, undefined, 2));
        }
    } else {
        modSourceData.lastUpdated = (new Date()).toISOString();
        // Save the json file out
        fs.writeFileSync("../../site/mods.json", JSON.stringify(modSourceData, undefined, 2));
    }
}
