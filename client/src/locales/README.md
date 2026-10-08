# LibreChat Localization Guide

This guide explains how to add new languages to LibreChat's localization system.

## Adding a New Language

To add a new language to LibreChat, follow these steps:

### 1. Add the Language to Locize Project

- Navigate to the [LibreChat locize project](https://www.locize.app/cat/62uyy7c9),
- Click the "ADD LANGUAGE" button, typically found within the "..." menu of the "Start to translate" card on the project overview page.

### 2. Update the Language Selector Component

Edit `client/src/components/Appearance/Selectors.tsx` and add your new language option to the `languageOptions` array:

```typescript
{ value: 'language-code', label: localize('com_nav_lang_language_name') },
```

Example:

```typescript
{ value: 'bo', label: localize('com_nav_lang_tibetan') },
{ value: 'uk-UA', label: localize('com_nav_lang_ukrainian') },
```

**Note:** Use the appropriate language code format:

- Use simple codes (e.g., `bo`) for languages without regional variants
- Use region-specific codes (e.g., `uk-UA`) when needed

### 3. Add Localization Keys

In `client/src/locales/en/translation.json`, add the corresponding localization key for your language label:

```json
"com_nav_lang_language_name": "Native Language Name",
```

Example:

```json
"com_nav_lang_tibetan": "བོད་སྐད་",
"com_nav_lang_ukrainian": "Українська",
```

**Best Practice:** Use the native language name as the value.

### 4. Create the Translation File

Create a new directory and translation file:

```bash
mkdir -p client/src/locales/[language-code]
```

Create `client/src/locales/[language-code]/translation.json` with an empty JSON object:

```json
{}
```

Example:

- `client/src/locales/bo/translation.json`
- `client/src/locales/uk/translation.json`

### 5. Configure i18n

Update `client/src/locales/i18n.ts`:

1. Import the new translation file:

```typescript
import translationLanguageCode from './language-code/translation.json';
```

2. Add it to the `resources` object:

```typescript
export const resources = {
  // ... existing languages
  'language-code': { translation: translationLanguageCode },
} as const;
```

Example:

```typescript
import translationBo from './bo/translation.json';
import translationUk from './uk/translation.json';

export const resources = {
  // ... existing languages
  bo: { translation: translationBo },
  uk: { translation: translationUk },
} as const;
```

### 6. Handle Fallback Languages (Optional)

If your language should fall back to a specific language when translations are missing, update the `fallbackLng` configuration in `i18n.ts`:

```typescript
fallbackLng: {
  'language-variant': ['fallback-language', 'en'],
  // ... existing fallbacks
},
```

## Translation Process

After adding a new language:

1. The empty translation file will be populated through LibreChat's automated translation platform
2. Only the English (`en`) translation file should be manually updated
3. Other language translations are managed externally

## Language Code Standards

- Use ISO 639-1 codes for most languages (e.g., `en`, `fr`, `de`)
- Use ISO 639-1 with region codes when needed (e.g., `pt-BR`, `zh-Hans`)
- Tibetan uses `bo` (Bodic)
- Ukrainian uses `uk` or `uk-UA` with region

## Testing

After adding a new language:

1. Restart the development server
2. Navigate to Settings > General
3. Verify your language appears in the dropdown
4. Select it to ensure it changes the UI language code

## Notes

- Keep language options alphabetically sorted in the dropdown for better UX
- Always use native script for language names in the dropdown
- The system will use English as fallback for any missing translations
