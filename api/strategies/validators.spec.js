// file deepcode ignore NoHardcodedPasswords: No hard-coded passwords in tests
const { errorsToString } = require('librechat-data-provider');
const { loginSchema, registerSchema } = require('./validators');

describe('Zod Schemas', () => {
  describe('loginSchema', () => {
    it('should validate a correct login object', () => {
      const result = loginSchema.safeParse({
        email: 'test@example.com',
        password: 'password123',
      });

      expect(result.success).toBe(true);
    });

    it('should invalidate an incorrect email', () => {
      const result = loginSchema.safeParse({
        email: 'testexample.com',
        password: 'password123',
      });

      expect(result.success).toBe(false);
    });

    it('should invalidate a short password', () => {
      const result = loginSchema.safeParse({
        email: 'test@example.com',
        password: 'pass',
      });

      expect(result.success).toBe(false);
    });

    it('should handle email with unusual characters', () => {
      const emails = ['test+alias@example.com', 'test@subdomain.example.co.uk'];
      emails.forEach((email) => {
        const result = loginSchema.safeParse({
          email,
          password: 'password123',
        });
        expect(result.success).toBe(true);
      });
    });

    it('should invalidate email without a domain', () => {
      const result = loginSchema.safeParse({
        email: 'test@.com',
        password: 'password123',
      });
      expect(result.success).toBe(false);
    });

    it('should invalidate password with only spaces', () => {
      const result = loginSchema.safeParse({
        email: 'test@example.com',
        password: '        ',
      });
      expect(result.success).toBe(false);
    });

    it('should invalidate password that is too long', () => {
      const result = loginSchema.safeParse({
        email: 'test@example.com',
        password: 'a'.repeat(129),
      });
      expect(result.success).toBe(false);
    });

    it('should invalidate empty email or password', () => {
      const result = loginSchema.safeParse({
        email: '',
        password: '',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('registerSchema', () => {
    it('should validate a correct register object', () => {
      const result = registerSchema.safeParse({
        name: 'John Doe',
        username: 'john_doe',
        email: 'john@example.com',
        password: 'password123',
        confirm_password: 'password123',
      });

      expect(result.success).toBe(true);
    });

    it('should allow the username to be omitted', () => {
      const result = registerSchema.safeParse({
        name: 'John Doe',
        email: 'john@example.com',
        password: 'password123',
        confirm_password: 'password123',
      });

      expect(result.success).toBe(true);
    });

    it('should invalidate a short name', () => {
      const result = registerSchema.safeParse({
        name: 'Jo',
        username: 'john_doe',
        email: 'john@example.com',
        password: 'password123',
        confirm_password: 'password123',
      });

      expect(result.success).toBe(false);
    });

    it('should handle empty username by transforming to null', () => {
      const result = registerSchema.safeParse({
        name: 'John Doe',
        username: '',
        email: 'john@example.com',
        password: 'password123',
        confirm_password: 'password123',
      });

      expect(result.success).toBe(true);
      expect(result.data.username).toBe(null);
    });

    it('should handle name with special characters', () => {
      const names = ['Jöhn Dœ', 'John <Doe>'];
      names.forEach((name) => {
        const result = registerSchema.safeParse({
          name,
          username: 'john_doe',
          email: 'john@example.com',
          password: 'password123',
          confirm_password: 'password123',
        });
        expect(result.success).toBe(true);
      });
    });

    it('should handle username with special characters', () => {
      const usernames = ['john.doe@', 'john..doe'];
      usernames.forEach((username) => {
        const result = registerSchema.safeParse({
          name: 'John Doe',
          username,
          email: 'john@example.com',
          password: 'password123',
          confirm_password: 'password123',
        });
        expect(result.success).toBe(true);
      });
    });

    it('should invalidate mismatched password and confirm_password', () => {
      const result = registerSchema.safeParse({
        name: 'John Doe',
        username: 'john_doe',
        email: 'john@example.com',
        password: 'password123',
        confirm_password: 'password124',
      });
      expect(result.success).toBe(false);
    });

    it('should handle email without a TLD', () => {
      const result = registerSchema.safeParse({
        name: 'John Doe',
        username: 'john_doe',
        email: 'john@domain',
        password: 'password123',
        confirm_password: 'password123',
      });
      expect(result.success).toBe(false);
    });

    it('should handle email with multiple @ symbols', () => {
      const result = registerSchema.safeParse({
        name: 'John Doe',
        username: 'john_doe',
        email: 'john@domain@com',
        password: 'password123',
        confirm_password: 'password123',
      });
      expect(result.success).toBe(false);
    });

    it('should handle name that is too long', () => {
      const result = registerSchema.safeParse({
        name: 'a'.repeat(81),
        username: 'john_doe',
        email: 'john@example.com',
        password: 'password123',
        confirm_password: 'password123',
      });
      expect(result.success).toBe(false);
    });

    it('should handle username that is too long', () => {
      const result = registerSchema.safeParse({
        name: 'John Doe',
        username: 'a'.repeat(81),
        email: 'john@example.com',
        password: 'password123',
        confirm_password: 'password123',
      });
      expect(result.success).toBe(false);
    });

    it('should handle password or confirm_password that is too long', () => {
      const result = registerSchema.safeParse({
        name: 'John Doe',
        username: 'john_doe',
        email: 'john@example.com',
        password: 'a'.repeat(129),
        confirm_password: 'a'.repeat(129),
      });
      expect(result.success).toBe(false);
    });

    it('should handle password or confirm_password that is just spaces', () => {
      const result = registerSchema.safeParse({
        name: 'John Doe',
        username: 'john_doe',
        email: 'john@example.com',
        password: '        ',
        confirm_password: '        ',
      });
      expect(result.success).toBe(false);
    });

    it('should handle null values for fields', () => {
      const result = registerSchema.safeParse({
        name: null,
        username: null,
        email: null,
        password: null,
        confirm_password: null,
      });
      expect(result.success).toBe(false);
    });

    it('should handle undefined values for fields', () => {
      const result = registerSchema.safeParse({
        name: undefined,
        username: undefined,
        email: undefined,
        password: undefined,
        confirm_password: undefined,
      });
      expect(result.success).toBe(false);
    });

    it('should handle extra fields not defined in the schema', () => {
      const result = registerSchema.safeParse({
        name: 'John Doe',
        username: 'john_doe',
        email: 'john@example.com',
        password: 'password123',
        confirm_password: 'password123',
        extraField: "I shouldn't be here",
      });
      expect(result.success).toBe(true);
    });

    it('should handle username with special characters from various languages', () => {
      const usernames = [
        // General
        'éèäöü',

        // German
        'Jöhn.Döe@',
        'Jöhn_Ü',
        'Jöhnß',

        // French
        'Jéan-Piérre',
        'Élève',
        'Fiançée',
        'Mère',

        // Spanish
        'Niño',
        'Señor',
        'Muñoz',

        // Portuguese
        'João',
        'Coração',
        'Pão',

        // Italian
        'Pietro',
        'Bambino',
        'Forlì',

        // Romanian
        'Mâncare',
        'Școală',
        'Țară',

        // Catalan
        'Niç',
        'Màquina',
        'Çap',

        // Swedish
        'Fjärran',
        'Skål',
        'Öland',

        // Norwegian
        'Blåbær',
        'Fjord',
        'Årstid',

        // Danish
        'Flød',
        'Søster',
        'Århus',

        // Icelandic
        'Þór',
        'Ætt',
        'Öx',

        // Turkish
        'Şehir',
        'Çocuk',
        'Gözlük',

        // Polish
        'Łódź',
        'Część',
        'Świat',

        // Czech
        'Čaj',
        'Řeka',
        'Život',

        // Slovak
        'Kočka',
        'Ľudia',
        'Žaba',

        // Croatian
        'Čovjek',
        'Šuma',
        'Žaba',

        // Hungarian
        'Tűz',
        'Ősz',
        'Ünnep',

        // Finnish
        'Mäki',
        'Yö',
        'Äiti',

        // Estonian
        'Tänav',
        'Öö',
        'Ülikool',

        // Latvian
        'Ēka',
        'Ūdens',
        'Čempions',

        // Lithuanian
        'Ūsas',
        'Ąžuolas',
        'Čia',

        // Dutch
        'Maïs',
        'Geërfd',
        'Coördinatie',
      ];

      const failingUsernames = usernames.reduce((acc, username) => {
        const result = registerSchema.safeParse({
          name: 'John Doe',
          username,
          email: 'john@example.com',
          password: 'password123',
          confirm_password: 'password123',
        });

        if (!result.success) {
          acc.push({ username, error: result.error });
        }

        return acc;
      }, []);

      if (failingUsernames.length > 0) {
        console.log('Failing Usernames:', failingUsernames);
      }
      expect(failingUsernames).toEqual([]);
    });

    it('should reject invalid usernames', () => {
      const invalidUsernames = [
        'john{doe}', // Contains `{` and `}`
        'j', // Only one character
        'a'.repeat(81), // More than 80 characters
        "' OR '1'='1'; --", // SQL Injection
        '{$ne: null}', // MongoDB Injection
        '<script>alert("XSS")</script>', // Basic XSS
        '"><script>alert("XSS")</script>', // XSS breaking out of an attribute
        '"><img src=x onerror=alert("XSS")>', // XSS using an image tag
      ];

      const passingUsernames = [];
      const failingUsernames = invalidUsernames.reduce((acc, username) => {
        const result = registerSchema.safeParse({
          name: 'John Doe',
          username,
          email: 'john@example.com',
          password: 'password123',
          confirm_password: 'password123',
        });

        if (!result.success) {
          acc.push({ username, error: result.error });
        }

        if (result.success) {
          passingUsernames.push({ username });
        }

        return acc;
      }, []);

      expect(failingUsernames.length).toEqual(invalidUsernames.length); // They should match since all invalidUsernames should fail.
    });
  });

  describe('errorsToString', () => {
    it('should convert errors to string', () => {
      const { error } = registerSchema.safeParse({
        name: 'Jo',
        username: 'john_doe',
        email: 'john@example.com',
        password: 'password123',
        confirm_password: 'password123',
      });

      const result = errorsToString(error.issues);
      expect(result).toBe('name: Too small: expected string to have >=3 characters');
    });
  });

  describe('MIN_PASSWORD_LENGTH environment variable', () => {
    // Note: These tests verify the behavior based on whatever MIN_PASSWORD_LENGTH
    // was set when the validators module was loaded
    const minLength = parseInt(process.env.MIN_PASSWORD_LENGTH, 10) || 8;

    it('should respect the configured minimum password length for login', () => {
      // Test password exactly at minimum length
      const resultValid = loginSchema.safeParse({
        email: 'test@example.com',
        password: 'a'.repeat(minLength),
      });
      expect(resultValid.success).toBe(true);

      // Test password one character below minimum
      if (minLength > 1) {
        const resultInvalid = loginSchema.safeParse({
          email: 'test@example.com',
          password: 'a'.repeat(minLength - 1),
        });
        expect(resultInvalid.success).toBe(false);
      }
    });

    it('should respect the configured minimum password length for registration', () => {
      // Test password exactly at minimum length
      const resultValid = registerSchema.safeParse({
        name: 'John Doe',
        email: 'john@example.com',
        password: 'a'.repeat(minLength),
        confirm_password: 'a'.repeat(minLength),
      });
      expect(resultValid.success).toBe(true);

      // Test password one character below minimum
      if (minLength > 1) {
        const resultInvalid = registerSchema.safeParse({
          name: 'John Doe',
          email: 'john@example.com',
          password: 'a'.repeat(minLength - 1),
          confirm_password: 'a'.repeat(minLength - 1),
        });
        expect(resultInvalid.success).toBe(false);
      }
    });

    it('should handle edge case of very short minimum password length', () => {
      // This test is meaningful only if MIN_PASSWORD_LENGTH is set to a very low value
      if (minLength <= 3) {
        const result = loginSchema.safeParse({
          email: 'test@example.com',
          password: 'abc',
        });
        expect(result.success).toBe(minLength <= 3);
      } else {
        // Skip this test if minimum length is > 3
        expect(true).toBe(true);
      }
    });
  });
});
