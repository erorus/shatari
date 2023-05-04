--[[

Oribos Exchange addon, v 0.1
https://oribos.exchange/

You should be able to query this DB from other addons:

    o={}
    OEMarketInfo(52719,o)
    print(o['market'])

Prints the market price of Greater Celestial Essence.
The item can be identified by anything GetItemInfo takes (itemid, itemstring, itemlink) or a battlepet itemstring/itemlink.

Prices are returned in copper, but accurate to the last *silver* (with coppers always 0).

    o['input']          -> the item/battlepet parameter you just passed in, verbatim

    o['itemid']         -> the ID of the item you just passed in

    o['species']        -> the species of the battlepet you just passed in
    o['breed']          -> the numeric breed ID of the battlepet
    o['quality']        -> the numeric quality/rarity of the battlepet

    o['age']            -> number of seconds since data was compiled

    o['region']         -> median market price across all realms in this region
    o['market']         -> median market price of the item on this AH over the past 4 days.

    o['days']           -> number of days since item was last seen on the auction house, when data was compiled. valid values 0 - 250.
     o['days'] = 251 means item was seen on this AH, but over 250 days ago
     o['days'] = 252 means the item is sold by vendors in unlimited quantities


You can also query and set whether the additional tooltip lines appear from this addon.
This is useful for other addons (Auctioneer, TSM, etc) that have their own fancy tooltips to disable OE tooltips and use OE simply as a data source.

    OETooltip()        -> returns a boolean whether OE tooltips are enabled
    OETooltip(true)    -> enables OE tooltips
    OETooltip(false)   -> disables OE tooltips

]]

local floor = math.floor
local tinsert, tonumber = tinsert, tonumber
local strLen, strByte, strSub = string.len, string.byte, string.sub
local PET_CAGE = 82800

local function coins(money)
    local GOLD="ffd100"
    local SILVER="e6e6e6"
    local COPPER="c8602c"

    local GSC_3 = "|cff%s%d|cff999999.|cff%s%02d|cff999999.|cff%s%02d|r"
    local GSC_2 = "|cff%s%d|cff999999.|cff%s%02d|r"

    money = floor(tonumber(money) or 0)
    local g = floor(money / 10000)
    local s = floor(money % 10000 / 100)
    local c = money % 100

    if (c > 0) then
        return GSC_3:format(GOLD, g, SILVER, s, COPPER, c)
    else
        return GSC_2:format(GOLD, g, SILVER, s)
    end
end

local function char2dec(s)
    local n, l = 0, strLen(s)
    for i=1,l,1 do
        n = n * 256 + strByte(s,i)
    end
    return n
end

local function round(num)
    return floor(num + 0.5)
end

local function roundToOdd(value)
    local floored = floor(value)
    if floor((value - floored) * 1000000) == 500000 then
        if floored % 2 == 0 then
            return floored + 1
        end

        return floored
    end

    return floor(value + 0.5)
end

local addonName, addonTable = ...
local prettyName = '|cFF33FF99Oribos Exchange|r'

local breedPoints = {
    [3] = {0.5,0.5,0.5,["name"]="B/B"},
    [4] = {0,2,0,["name"]="P/P"},
    [5] = {0,0,2,["name"]="S/S"},
    [6] = {2,0,0,["name"]="H/H"},
    [7] = {0.9,0.9,0,["name"]="H/P"},
    [8] = {0,0.9,0.9,["name"]="P/S"},
    [9] = {0.9,0,0.9,["name"]="H/S"},
    [10] = {0.4,0.9,0.4,["name"]="P/B"},
    [11] = {0.4,0.4,0.9,["name"]="S/B"},
    [12] = {0.9,0.4,0.4,["name"]="H/B"},
}
local breedCandidates = {}
local function getBreedFromPetLink(link)
    local petString = string.match(link, "battlepet[%-?%d:]+")
    local _, speciesID, level, quality, health, power, speed = strsplit(":", petString)

    speciesID = tonumber(speciesID,10)
    level = tonumber(level,10)
    quality = tonumber(quality,10)
    health = tonumber(health,10)
    power = tonumber(power,10)
    speed = tonumber(speed,10)

    local speciesStats = addonTable.speciesStats[speciesID] or addonTable.speciesStats[0]
    local qualityFactor = level * (1 + quality / 10)
    wipe(breedCandidates)

    for breed, points in pairs(breedPoints) do
        local breedHealth = roundToOdd((speciesStats[1] + points[1]) * 5 * qualityFactor + 100)
        local breedPower = roundToOdd((speciesStats[2] + points[2]) * qualityFactor)
        local breedSpeed = roundToOdd((speciesStats[3] + points[3]) * qualityFactor)

        if (breedHealth == health) and (breedPower == power) and (breedSpeed == speed) then
            tinsert(breedCandidates, breed)
        end
    end

    local breed
    if #breedCandidates == 1 then
        breed = breedCandidates[1]
    elseif #breedCandidates > 1 then
        for i=1,#breedCandidates,1 do
            local dataKey = PET_CAGE .. '-' .. speciesID .. '-' .. breedCandidates[i]
            if addonTable.marketData[dataKey] then
                breed = breedCandidates[i]
            end
        end
    end

    return breed, speciesID, level, quality, health, power, speed
end

local marketInfoCache, marketInfoCacheKeys, marketInfoCacheMaxDepth = {}, {}, 16

local function InfoCacheKeyComparitor(x,y)
    return (marketInfoCache[x] and marketInfoCache[x]['__queried'] or 0) <
           (marketInfoCache[y] and marketInfoCache[y]['__queried'] or 0)
end

-- The auction house UI builds its own fake tooltip via the base item plus a custom item level and suffix. This mess
-- helps us pull out the item key they use to show that tooltip so we know the correct item level.
local browseItemKey
local function onBrowseLineEnter(line, rowData)
    if rowData and rowData.itemKey then
        browseItemKey = rowData.itemKey
    end
end
local function onBrowseLineLeave()
    browseItemKey = nil
end
local function checkAuctionHouseLineHandlers()
    if not AuctionHouseFrame then return end

    local oldEnter = AuctionHouseFrame.BrowseResultsFrame.ItemList.lineOnEnterCallback;
    local oldLeave = AuctionHouseFrame.BrowseResultsFrame.ItemList.lineOnLeaveCallback;
    if not (oldEnter and oldLeave) then return end

    AuctionHouseFrame.BrowseResultsFrame.ItemList:SetLineOnEnterCallback(function (...)
        onBrowseLineEnter(...)
        oldEnter(...)
    end)
    AuctionHouseFrame.BrowseResultsFrame.ItemList:SetLineOnLeaveCallback(function (...)
        onBrowseLineLeave(...)
        oldLeave(...)
    end)

    return true
end
local function getActiveItemKey()
    if browseItemKey then return browseItemKey end
    if not AuctionHouseFrame then return end
    if GameTooltip:GetOwner() == AuctionHouseFrame.ItemBuyFrame.ItemDisplay.ItemButton then
        return AuctionHouseFrame.ItemBuyFrame.ItemDisplay.itemKey
    end
end

--[[
    pass a table as the second argument to wipe and reuse that table
    otherwise a new table will be created and returned
]]
function OEMarketInfo(item,...)
    if item == 0 then
        if addonTable.marketData then
            return true
        else
            return false
        end
    end

    local numargs = select('#', ...)
    local tr

    if (numargs > 0) and (type(select(1,...)) == 'table') then
        tr = select(1,...)
        wipe(tr)
    end

    if not addonTable.marketData then return tr end
    local cacheKey = item
    local activeItemKey = getActiveItemKey()
    if activeItemKey then
        cacheKey = cacheKey .. '~~~' .. activeItemKey.itemID .. '-' .. activeItemKey.itemLevel .. '-' .. activeItemKey.itemSuffix
    end

    if marketInfoCache[cacheKey] then
        marketInfoCache[cacheKey]['__queried'] = GetTime()
        if not marketInfoCache[cacheKey]['input'] then return tr end
        if not tr then tr = {} end
        for k,v in pairs(marketInfoCache[cacheKey]) do
            tr[k] = v
        end
        tr['__queried'] = nil
        return tr
    end

    if #marketInfoCacheKeys >= marketInfoCacheMaxDepth then
        -- reuse oldest cache table
        sort(marketInfoCacheKeys, InfoCacheKeyComparitor)
        marketInfoCache[cacheKey] = marketInfoCache[marketInfoCacheKeys[1]] or {}
        wipe(marketInfoCache[cacheKey])

        while #marketInfoCacheKeys >= marketInfoCacheMaxDepth do
            marketInfoCache[marketInfoCacheKeys[1]] = nil
            table.remove(marketInfoCacheKeys, 1)
        end
    else
        -- add new table to cache
        marketInfoCache[cacheKey] = {}
    end
    table.insert(marketInfoCacheKeys, cacheKey)
    marketInfoCache[cacheKey]['__queried'] = GetTime()

    local _, link, dataKey
    local iid, breed, species, quality

    if (strfind(item, 'battlepet:')) then
        breed, species, _, quality = getBreedFromPetLink(item)
        dataKey = PET_CAGE .. '-' .. (species or 0) .. '-' .. (breed or 0)
    else
        local itemId, _, _, _, _, itemClass = GetItemInfoInstant(item)
        if not itemId then return tr end

        iid = itemId
        dataKey = tostring(iid)

        if (itemClass == 2) or (itemClass == 4) then
            local effectiveLevel
            local nameId

            local activeItemKey = getActiveItemKey()
            if activeItemKey and activeItemKey.itemID == itemId then
                if activeItemKey.itemLevel > 0 then
                    effectiveLevel = activeItemKey.itemLevel
                    if activeItemKey.itemSuffix > 0 then
                        nameId = activeItemKey.itemSuffix
                    end
                end
            end

            effectiveLevel = effectiveLevel or GetDetailedItemLevelInfo(item)
            -- effectiveLevel may be nil when GetItemInfo didn't have the item readily available.
            if effectiveLevel then
                nameId = nameId or addonTable.getNameId(item)

                local testKey
                if nameId then
                    testKey = dataKey .. '-' .. effectiveLevel .. '-' .. nameId
                else
                    testKey = dataKey .. '-' .. effectiveLevel
                end
                if addonTable.marketData[testKey] then
                    dataKey = testKey
                end
            end
        end
    end

    local dta = addonTable.marketData[dataKey]
    if not dta then return tr end

    if not tr then tr = {} end

    tr['input'] = item
    if (iid) then
        tr['itemid'] = iid
    end
    if (species) then
        tr['species'] = species
        tr['breed'] = breed
        tr['quality'] = quality
    end

    if addonTable.dataAge then
        tr['age'] = time() - addonTable.dataAge
    end

    local priceSize = strByte(dta, 1)
    local offset = 2

    tr['region'] = round(char2dec(strSub(dta, offset, offset+priceSize-1))) * 100
    if tr['region'] == 0 then tr['region'] = nil end
    offset = offset + priceSize

    tr['days'] = strByte(dta, offset, offset)
    offset = offset + 1

    tr['market'] = round(char2dec(strSub(dta, offset, offset+priceSize-1))) * 100
    -- offset = offset + priceSize

    for k,v in pairs(tr) do
        marketInfoCache[cacheKey][k] = v
    end

    return tr
end

--[[
    enable/disable/query whether the OE tooltip additions are enabled
]]
local tooltipsEnabled = true
function OETooltip(...)
    if select('#', ...) >= 1 then
        tooltipsEnabled = not not select(1,...) --coerce into boolean

        local line = strmatch(debugstack(2, 1, 0), "[Aa][Dd][Dd][Oo][Nn][Ss]\\([^\\]+)")
        if line and line ~= addonName then
            local callingName, callingTitle = GetAddOnInfo(line)
            if callingName then
                callingName = callingTitle or callingName
                if tooltipsEnabled then line = 'enabled' else line = 'disabled' end
                print(prettyName .. " - Tooltip prices " .. line .. " by " .. callingName)
            end
        end
    end
    return tooltipsEnabled
end

local tooltipsSettings = {}

local qualityRGB = {
    [0] = {0.616,0.616,0.616},
    [1] = {1,1,1},
    [2] = {0.118,1,0},
    [3] = {0,0.439,0.867},
    [4] = {0.639,0.208,0.933},
    [5] = {1,0.502,0},
    [6] = {0.898,0.8,0.502},
    [7] = {0.898,0.8,0.502},
    [8] = {0,0.8,1},
    [9] = {0.443,0.835,1},
}

local LibExtraTip = LibStub("LibExtraTip-1")
local regionName = "Regional"
local realmName = "Realm"

local function buildExtraTip(tooltip, pricingData)
    local r,g,b = .9,.8,.5

    if pricingData['breed'] and breedPoints[pricingData['breed']] and qualityRGB[pricingData['quality']] then
        LibExtraTip:AddLine(tooltip,
            "Breed " .. breedPoints[pricingData['breed']]["name"] .. " - Species " .. pricingData['species'],
            qualityRGB[pricingData['quality']][1],
            qualityRGB[pricingData['quality']][2],
            qualityRGB[pricingData['quality']][3],
            true)
    end

    LibExtraTip:AddLine(tooltip," ",r,g,b,true)

    if (pricingData['age'] > 3*24*60*60) and not tooltipsSettings['disable-age'] then
        LibExtraTip:AddLine(tooltip,"As of "..SecondsToTime(pricingData['age'],pricingData['age']>60).." ago:",r,g,b,true)
    end

    if pricingData['market'] and pricingData['market'] > 0 and not tooltipsSettings['disable-market'] then
        LibExtraTip:AddDoubleLine(tooltip,realmName,coins(pricingData['market']),r,g,b,nil,nil,nil,true)
    end

    if pricingData['region'] and not tooltipsSettings['disable-region'] then
        LibExtraTip:AddDoubleLine(tooltip,regionName,coins(pricingData['region']),r,g,b,nil,nil,nil,true)
    end

    if not tooltipsSettings['disable-lastSeen'] then
        if pricingData['days'] == 252 then
            LibExtraTip:AddLine(tooltip,"Sold by Vendors",r,g,b,true)
        elseif pricingData['days'] > 250 then
            LibExtraTip:AddLine(tooltip,"Last seen over 250 days ago",r,g,b,true)
        elseif pricingData['days'] > 1 then
            LibExtraTip:AddLine(tooltip,"Last seen "..SecondsToTime(pricingData['days']*24*60*60).." ago",r,g,b,true)
        end
    end
end

local function printHelp()
    local function getLineStatus(lineName)
        if tooltipsSettings['disable-' .. lineName] then
            return '(|cFFFF0000OFF|r)'
        else
            return '(|cFF00FF00ON|r)'
        end
    end

    local regionName = addonTable.region or "Regional"

    print(prettyName .. " - Arguments for |cFFFFFF78/oetooltip|r are:")
    print("|cFFFFFF78on|r|||cFFFFFF78off|r - Enable/disable tooltip modifications.")
    print("|cFFFFFF78reset|r - Reset all preferences and enable all lines.")
    print("|cFFFFFF78quiet|r - Disable all lines.")
    print("|cFFFFFF78age|r - Toggle data age line. " .. getLineStatus('age'))
    print("|cFFFFFF78market|r - Toggle realm price line. " .. getLineStatus('market'))
    print("|cFFFFFF78region|r - Toggle " .. regionName .. " median line. " .. getLineStatus('region'))
    print("|cFFFFFF78lastseen|r - Toggle 'Last seen' line. " .. getLineStatus('lastSeen'))
end

local dataResults = {}
local function onTooltipSetItem(tooltip, itemLink, quantity)
    if not addonTable.marketData then return end
    if not tooltipsEnabled then return end
    if not itemLink then return end

    OEMarketInfo(itemLink, dataResults)

    if not (dataResults['input'] and (dataResults['input'] == itemLink)) then
        return
    end

    buildExtraTip(tooltip, dataResults)
end

local eventframe = CreateFrame("FRAME",addonName.."Events")

local function onEvent(self,event,arg)
    if event == "PLAYER_ENTERING_WORLD" then
        eventframe:UnregisterEvent("PLAYER_ENTERING_WORLD")

        local realmId = GetRealmID()
        if not realmId then
            local guid = UnitGUID("player")
            if guid then
                realmId = tonumber(strmatch(guid, "^Player%-(%d+)"))
            end
        end
        if not realmId then
            realmId = "nil"
        else
            for i=1,#addonTable.dataLoads,1 do
                addonTable.dataLoads[i](realmId)
                addonTable.dataLoads[i]=nil
            end
        end
        wipe(addonTable.dataLoads)
        collectgarbage("collect") -- lots of strings made and trunc'ed in MarketData

        if not addonTable.realmIndex then
            print(prettyName .. " - Warning: could not find data for realm ID "..realmId..", no data loaded!")
        elseif not addonTable.marketData then
            print(prettyName .. " - Warning: no data loaded!")
        else
            regionName = addonTable.region .. " Region"
            realmName = GetRealmName()
            if not tooltipsEnabled then
                print(prettyName .. " - Tooltip prices disabled. Run |cFFFFFF78/oetooltip on|r to enable.")
            end
            LibExtraTip:AddCallback({type = "item", callback = onTooltipSetItem})
            LibExtraTip:AddCallback({type = "battlepet", callback = onTooltipSetItem})
            LibExtraTip:RegisterTooltip(GameTooltip)
            LibExtraTip:RegisterTooltip(ItemRefTooltip)
            LibExtraTip:RegisterTooltip(BattlePetTooltip)
            LibExtraTip:RegisterTooltip(FloatingBattlePetTooltip)
        end
    elseif event == "ADDON_LOADED" and arg == addonName then
        tooltipsEnabled = not _G["OETooltipsHidden"]
        tooltipsSettings = _G["OETooltipsSettings"] or {}
    elseif event == "AUCTION_HOUSE_SHOW" then
        if checkAuctionHouseLineHandlers() then
            eventframe:UnregisterEvent("AUCTION_HOUSE_SHOW")
        end
    elseif event == "PLAYER_LOGOUT" then
        _G["OETooltipsHidden"] = not tooltipsEnabled
        _G["OETooltipsSettings"] = tooltipsSettings
    end
end

eventframe:RegisterEvent("PLAYER_ENTERING_WORLD")
eventframe:RegisterEvent("ADDON_LOADED")
eventframe:RegisterEvent("AUCTION_HOUSE_SHOW")
eventframe:RegisterEvent("PLAYER_LOGOUT")
eventframe:SetScript("OnEvent", onEvent)

SLASH_ORIBOSEXCHANGE1 = '/oetooltip'
function SlashCmdList.ORIBOSEXCHANGE(msg)
    local lineNames = {
        ['age'] = 'age',

        ['market'] = 'market',

        ['globalmedian'] = 'globalMedian',
        ['global-median'] = 'globalMedian',
        ['regionmedian'] = 'globalMedian',
        ['region-median'] = 'globalMedian',

        ['lastseen'] = 'lastSeen',
        ['last-seen'] = 'lastSeen',
    }

    local loweredMsg = string.lower(msg)

    if msg == 'reset' then
        wipe(tooltipsSettings)
        OETooltip(true)
        print(prettyName .. " - Preferences reset to defaults.")
    elseif msg == 'quiet' then
        for input, lineName in pairs(lineNames) do
            local settingName = 'disable-' .. lineName
            tooltipsSettings[settingName] = true
        end
        print(prettyName .. " - All lines disabled.")

        return
    elseif lineNames[loweredMsg] then
        local lineName = lineNames[loweredMsg]
        local settingName = 'disable-' .. lineName
        if tooltipsSettings[settingName] then
            tooltipsSettings[settingName] = nil;
            print(prettyName .. " - |cFFFFFF78" .. lineName .. "|r line enabled.")
        else
            tooltipsSettings[settingName] = true;
            print(prettyName .. " - |cFFFFFF78" .. lineName .. "|r line disabled.")
        end

        return
    elseif msg == 'on' then
        OETooltip(true)
        print(prettyName .. " - Tooltip additions enabled.")
    elseif msg == 'off' then
        OETooltip(false)
        print(prettyName .. " - Tooltip additions disabled.")
    else
        printHelp()
    end
end

local origGetAuctionBuyout = GetAuctionBuyout
local getAuctionBuyoutTable = {}

function GetAuctionBuyout(item) -- Tekkub's API
    local result = OEMarketInfo(item, getAuctionBuyoutTable)
    if (result and result['input'] == item) then
        if (result['market']) then
            return result['market']
        else
            return result['globalMedian']
        end
    end

    if (origGetAuctionBuyout) then
        return origGetAuctionBuyout(item)
    end

    return nil
end


