import { langFromPath } from '../ReadFileCall';

describe('langFromPath', () => {
  describe('common extensions', () => {
    it.each([
      ['main.py', 'python'],
      ['index.js', 'javascript'],
      ['app.ts', 'typescript'],
      ['component.tsx', 'typescript'],
      ['component.jsx', 'javascript'],
      ['lib.rs', 'rust'],
      ['main.go', 'go'],
      ['Main.java', 'java'],
    ])('%s -> %s', (filename, expected) => {
      expect(langFromPath(filename)).toBe(expected);
    });
  });

  describe('full paths', () => {
    it('resolves language from the filename at the end of a Unix path', () => {
      expect(langFromPath('/home/user/project/main.py')).toBe('python');
    });

    it('resolves language when path has multiple segments', () => {
      expect(langFromPath('/usr/local/src/app/index.ts')).toBe('typescript');
    });

    it('ignores dots in directory names and uses the file extension', () => {
      expect(langFromPath('my.project/config.json')).toBe('json');
    });
  });

  describe('extensionless filename map', () => {
    it('returns makefile for "makefile"', () => {
      expect(langFromPath('makefile')).toBe('makefile');
    });

    it('returns makefile for mixed-case Makefile', () => {
      expect(langFromPath('Makefile')).toBe('makefile');
    });

    it('returns dockerfile for Dockerfile', () => {
      expect(langFromPath('Dockerfile')).toBe('dockerfile');
    });

    it('returns dockerfile for lowercase dockerfile', () => {
      expect(langFromPath('dockerfile')).toBe('dockerfile');
    });

    it('resolves filename map entry from a full path', () => {
      expect(langFromPath('/home/user/project/Makefile')).toBe('makefile');
    });
  });

  describe('case insensitivity', () => {
    it('handles uppercase extension .MD -> markdown', () => {
      expect(langFromPath('README.MD')).toBe('markdown');
    });

    it('handles mixed-case extension .Ts -> typescript', () => {
      expect(langFromPath('module.Ts')).toBe('typescript');
    });

    it('handles uppercase extension .JS -> javascript', () => {
      expect(langFromPath('bundle.JS')).toBe('javascript');
    });
  });

  describe('unknown or unrecognised inputs', () => {
    it('returns plaintext for unknown extension', () => {
      expect(langFromPath('archive.xyz')).toBe('plaintext');
    });

    it('returns plaintext for empty string', () => {
      expect(langFromPath('')).toBe('plaintext');
    });

    it('returns plaintext for dotfile with no mapped extension (.gitignore)', () => {
      expect(langFromPath('.gitignore')).toBe('plaintext');
    });

    it('returns plaintext for dotfile in a full path', () => {
      expect(langFromPath('/home/user/.gitignore')).toBe('plaintext');
    });
  });

  describe('additional mapped extensions', () => {
    it.each([
      ['query.sql', 'sql'],
      ['style.css', 'css'],
      ['style.scss', 'scss'],
      ['style.less', 'less'],
      ['index.html', 'html'],
      ['config.xml', 'xml'],
      ['config.yaml', 'yaml'],
      ['config.yml', 'yaml'],
      ['config.toml', 'toml'],
      ['script.sh', 'bash'],
      ['script.bash', 'bash'],
      ['script.zsh', 'bash'],
      ['data.json', 'json'],
      ['file.c', 'c'],
      ['file.h', 'c'],
      ['file.cpp', 'cpp'],
      ['file.hpp', 'cpp'],
      ['App.kt', 'kotlin'],
      ['App.swift', 'swift'],
      ['Program.cs', 'csharp'],
      ['script.php', 'php'],
      ['mod.lua', 'lua'],
      ['analysis.r', 'r'],
      ['module.rb', 'ruby'],
    ])('%s -> %s', (filename, expected) => {
      expect(langFromPath(filename)).toBe(expected);
    });
  });
});
