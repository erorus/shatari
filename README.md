# Project Shatari - Back End

This is the auction data collection code for [Undermine Exchange](https://undermine.exchange), which provides historical auction pricing data for World of Warcraft.

This is one of three layers to this application stack:
* [Project Shatari - Data](https://github.com/erorus/shatari-data) - Parses static game data into JSON files used by other layers. Run from a development environment.
* [Project Shatari - Back End](https://github.com/erorus/shatari) - Regularly consumes dynamic API data into custom-format data files consumed by the front end. Run on the server.
* [Project Shatari - Front End](https://github.com/erorus/shatari-front) - Presents the web interface to the application which consumes data from other layers to render the output. Serve via HTTPS.

## Static Site Architecture

This site is developed as a "static site," in that incoming requests to the server are not processed via PHP, node.js, or any other scripting language. Nginx is intended to serve all files as they are stored on disk.

This back end repository will have a persistent process running in the background to update files in-place on disk, but otherwise it does not interact with incoming requests in any way.

## Main Components

* `credentials.sh` should be made from the `.dist` file.
  * `BATTLE_NET_KEY` and `_SECRET` come from your [Battle.net API](https://develop.battle.net) credentials.
  * `CURSEFORGE_*` tokens are for [automatically publishing addon updates to CurseForge](https://support.curseforge.com/support/solutions/articles/9000208346-about-the-curseforge-api-and-how-to-apply-for-a-key).
  * `WAGO_*` token are for [automatically publishing addon updates to Wago](https://docs.wago.io/).
  * `*_PINGBACK` are URLs used for monitoring tools. I use [Oh Dear](https://ohdear.app/).
* `src/main.js` is the node.js script that's expected to be running all the time. It exits early if it detects that another instance is running, so you can run this regularly via cron. This reads auction house API data from Battle.net and saves it in thousands of data files to be used by the front end (linked above).
* `make-bound-json.sh` should be run regularly to detect when there are items posted to the auction house that are marked as "Binds when Picked Up" in game data. Normally, we omit information about such items from the front end, because we never expect to see them. But it does happen on occasion, via game hotfixes or bonuses, etc. When we do find such items, this script will update the JSON files on the front end to include the basic data for those items (name, icon, etc).
* `realm-list.sh` should also be run regularly to automatically update our local list of realms, based on the realms provided by the Battle.net API.
* `addon.sh` is automatically run 3 times a week to generate and repackage the latest auction data for the [Oribos Exchange addon](https://www.curseforge.com/wow/addons/oribos-exchange).

## Data Architecture

The reason this project exists is because I wanted to find a way to store and maintain a *lot* of auction house data in a performant way, without using a traditional database system. I came up with a series of file formats to store various "states", which would be served to the browser as-is, where the JS would parse those files to extract the data. We have scripts to maintain a global state, a region state for each region (US/EU/TW/KR), a realm state for each realm, and an item state for each item on each realm.

There are about 186 realms, and 4 region-wide commodities "realms". There are over 30,000 items, and many of those items (weapons and armor) have variations we track (item levels and name suffixes). We have over 58 million files in the filesystem, some subset of which gets updated every hour as new auction data comes in. For performance, it's important only to read/write a file when it actually has some change in its data, so the files for rare items are rarely modified.

These files only use up about 56GB of disk space, meaning the average file size is less than 1KB. This system allows us to provide hourly-resolution pricing data for the past 14 days, and daily-resolution pricing data since September 2022.

## Thanks

Thanks to Blizzard for the [Battle.net API](https://develop.battle.net).

Thanks to [CurseForge](https://www.curseforge.com) and [Wago](https://wago.io) for hosting addons, providing upload APIs, and having author rewards programs.

Thanks to my patrons, and the entire WoW Economy community, for their interest and support for this project.

Click here to support my WoW projects: [![Become a Patron!](https://everynothing.net/patronButton.png)](https://www.patreon.com/bePatron?u=4445407)

## License

Copyright 2026 Gerard Dombroski

Licensed under the Apache License, Version 2.0 (the "License");
you may not use these files except in compliance with the License.
You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
