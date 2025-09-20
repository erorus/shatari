if GetLocale() ~= "ruRU" then
    return
end

local addonName, addonTable = ...
local L = addonTable.localization

-- Localization Table (Adaptation of Lua code into Russian ZamestoTV)
L["%s Region"] = "%s Регион"
L["Regional"] = "Регион"
L["Realm"] = "Сервер"
L["Breed %s - Species %s"] = "Порода %s - Вид %s"
L["As of %s ago:"] = "По состоянию на %s назад:"
L["Sold by Vendors"] = "Продается у торговцев"
L["Last seen over 250 days ago"] = "Последний раз видели более 250 дней назад"
L["Last seen %s ago"] = "Последний раз видели %s назад"
L["Tooltip prices disabled. Run %s to enable."] = "Цены в подсказках отключены. Используйте %s, чтобы включить."
L["Arguments for %s are:"] = "Аргументы для %s:"
L["Enable/disable tooltip modifications."] = "Включить/отключить модификации подсказок."
L["Reset all preferences and enable all lines."] = "Сбросить все настройки и включить все строки."
L["Toggle displaying coin prices."] = "Переключить отображение цен в монетах."
L["Disable all lines."] = "Отключить все строки."
L["Toggle data age line."] = "Переключить строку возраста данных."
L["Toggle realm price line."] = "Переключить строку цены сервера."
L["Toggle %s median line."] = "Переключить строку медианы %s."
L["Toggle 'Last seen' line."] = "Переключить строку 'Последний раз видели'."
L["Preferences reset to defaults."] = "Настройки сброшены до стандартных."
L["All lines disabled."] = "Все строки отключены."
L["%s line enabled."] = "Строка %s включена."
L["%s line disabled."] = "Строка %s отключена."
L["Coins display enabled."] = "Отображение монет включено."
L["Coins display disabled."] = "Отображение монет отключено."
L["Tooltip additions enabled."] = "Добавления в подсказки включены."
L["Tooltip additions disabled."] = "Добавления в подсказки отключены."
L["Warning: could not find data for realm ID %s, no data loaded!"] = "Предупреждение: не удалось найти данные для ID сервера %s, данные не загружены!"
L["Warning: no data loaded!"] = "Предупреждение: данные не загружены!"
L["Tooltip prices %s by %s"] = "Цены в подсказках %s аддоном %s"
L["enabled"] = "включены"
L["disabled"] = "отключены"
L["OFF"] = "ВЫКЛ"
L["ON"] = "ВКЛ"
