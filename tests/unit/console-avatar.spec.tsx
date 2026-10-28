/**
 * @jest-environment jsdom
 */

/**
 * The console avatar (components/shell/ConsoleChrome.tsx): the Google account's
 * own photo when it has one, otherwise initials drawn from the name itself, so
 * an email account and a Google account without a photo look the same.
 */

import { fireEvent, render } from '@testing-library/react'
import { Avatar, initialsOf } from '@/components/shell/ConsoleChrome'

const PHOTO = 'https://lh3.googleusercontent.com/a/ACg8ocOwnPhoto=s100'

describe('initialsOf', () => {
  it('takes the first letters of the first two words', () => {
    expect(initialsOf({ name: 'Ada Lovelace' })).toBe('AL')
    expect(initialsOf({ name: 'ada byron lovelace' })).toBe('AB')
    expect(initialsOf({ name: 'Ada' })).toBe('A')
  })

  it('reads only the name, not a department after a bar or parenthesis', () => {
    // The shape of name the bug was reported with ("Name | Department |
    // School"): its avatar drew the bar.
    expect(initialsOf({ name: '김민준 | 컴퓨터공학과 | 예시대(서울)' })).toBe('김')
    expect(initialsOf({ name: 'Ada Lovelace | Engineering' })).toBe('AL')
    expect(initialsOf({ name: 'Ada Lovelace (Analytical Engines)' })).toBe('AL')
  })

  it('draws one character for a Chinese, Japanese or Korean name', () => {
    expect(initialsOf({ name: '홍 길동' })).toBe('홍')
    expect(initialsOf({ name: '山田 太郎' })).toBe('山')
  })

  it('composes a decomposed Hangul name before taking its first character', () => {
    expect(initialsOf({ name: '아린'.normalize('NFD') })).toBe('아')
  })

  it('skips anything that is not a letter', () => {
    expect(initialsOf({ name: '​ Ada - Lovelace' })).toBe('AL')
    expect(initialsOf({ name: '​Ada Lovelace' })).toBe('AL')
  })

  it('falls back to the address when the name has no letters', () => {
    expect(initialsOf({ name: null, email: 'ada@example.com' })).toBe('A')
    expect(initialsOf({ name: '| |', email: '_ada@example.com' })).toBe('A')
    expect(initialsOf(null)).toBe('')
  })
})

describe('Avatar', () => {
  it('shows the Google photo when the account has one of its own', () => {
    const { container } = render(<Avatar user={{ name: 'Ada Lovelace', avatarUrl: PHOTO }} />)
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe(PHOTO)
    // Google's photo host is not told which console page asked.
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(container.textContent).toBe('')
  })

  it('shows initials and no image for every other account', () => {
    const { container } = render(<Avatar user={{ name: 'Ada Lovelace', email: 'ada@example.com', avatarUrl: null }} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('AL')
  })

  it('falls back to initials when the photo does not load', () => {
    const { container } = render(<Avatar user={{ name: 'Ada Lovelace', avatarUrl: PHOTO }} />)
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('AL')
  })
})
