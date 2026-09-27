/*---------------------------------------------------------------------------------------------
 *  wisp: not part of Code - OSS. Edit editor/overlay in the wisp repo, not this copy.
 *--------------------------------------------------------------------------------------------*/

import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import { Registry } from '../../registry/common/platform.js';

/**
 * Settings ids of the built-in themes in `extensions/theme-wisp`. They match
 * `contributes.themes[].id`, which is what `workbench.colorTheme` stores.
 */
export const WISP_DARK_THEME_ID = 'Wisp Dark';
export const WISP_LIGHT_THEME_ID = 'Wisp Light';

// Wisp Dark is the default for a new install in both windows (chat v2, #294).
// A default override fills a setting only when the user has not chosen one, so
// an existing theme stays. Preferred light is Wisp Light so automatic detection
// uses the pair; detection itself stays off unless the user turns it on.
// Neither key has an `agentsWindow` default, which would win over this override.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		'workbench.colorTheme': WISP_DARK_THEME_ID,
		'workbench.preferredDarkColorTheme': WISP_DARK_THEME_ID,
		'workbench.preferredLightColorTheme': WISP_LIGHT_THEME_ID,
	},
}]);
