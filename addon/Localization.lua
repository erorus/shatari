local addonName, addonTable = ...

addonTable.localization = {}
setmetatable(addonTable.localization, {
    __index = function (table, key)
        return key
    end
})
