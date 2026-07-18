import { describe, expect, test } from 'vitest';
import { typeColor, typeColors } from './type-color';

describe('typeColor', () => {
  test('round-robins the palette once types outnumber it', () => {
    expect(typeColor(0).bg).toBe(typeColor(12).bg);
    expect(typeColor(0).bg).not.toBe(typeColor(1).bg);
  });

  test('picks a legible foreground by luminance', () => {
    expect(typeColor(0).fg).toBe('#fff'); // red swatch -> white text
    expect(typeColor(2).fg).toBe('#000'); // amber swatch -> black text
  });

  test('maps sorted distinct types to stable colors', () => {
    const colors = typeColors(['bug', 'feature', 'task']);
    expect(colors.get('bug')).toEqual(typeColor(0));
    expect(colors.get('task')).toEqual(typeColor(2));
  });
});
