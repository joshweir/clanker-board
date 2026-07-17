import { screen, within } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import type { ApiClient } from '../api'
import { renderApp } from '../test/harness'

const seedProject = (name: string, key: string) => async (client: ApiClient) => {
  await client.api.projects.$post({ json: { name, key } })
}

describe('project list', () => {
  test('a fresh instance invites you to create your first project', async () => {
    await renderApp()
    expect(await screen.findByRole('button', { name: 'Create your first project' })).toBeDefined()
  })

  test('lists projects that already exist', async () => {
    await renderApp(seedProject('Alpha', 'ALPHA'))
    const row = await screen.findByRole('link', { name: /ALPHA/ })
    expect(within(row).getByText('Alpha')).toBeDefined()
  })
})

describe('create project', () => {
  test('auto-suggests an editable key from the name and creates the project', async () => {
    const { user } = await renderApp()
    await user.click(await screen.findByRole('button', { name: 'Create your first project' }))

    await user.type(screen.getByLabelText('Name'), 'Demo')
    const keyInput = screen.getByLabelText<HTMLInputElement>('Key')
    expect(keyInput.value).toBe('DEMO')

    await user.click(screen.getByRole('button', { name: 'Create' }))

    const row = await screen.findByRole('link', { name: /DEMO/ })
    expect(within(row).getByText('Demo')).toBeDefined()
  })

  test('the suggested key stays editable', async () => {
    const { user, client } = await renderApp()
    await user.click(await screen.findByRole('button', { name: 'Create your first project' }))
    await user.type(screen.getByLabelText('Name'), 'Demo')
    const keyInput = screen.getByLabelText<HTMLInputElement>('Key')
    await user.clear(keyInput)
    await user.type(keyInput, 'CustomKey')
    expect(keyInput.value).toBe('CUSTOMKEY')

    await user.click(screen.getByRole('button', { name: 'Create' }))
    await screen.findByRole('link', { name: /CUSTOMKEY/ })

    const list = await client.api.projects.$get()
    expect((await list.json()).map((p) => p.key)).toEqual(['CUSTOMKEY'])
  })

  test('surfaces a shape error for an invalid key', async () => {
    const { user } = await renderApp()
    await user.click(await screen.findByRole('button', { name: 'Create your first project' }))
    await user.type(screen.getByLabelText('Name'), 'Demo')
    const keyInput = screen.getByLabelText('Key')
    await user.clear(keyInput)
    await user.type(keyInput, 'A')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByRole('alert')).toBeDefined()
    expect(screen.queryByRole('link')).toBeNull()
  })

  test('surfaces the server uniqueness error on a duplicate key', async () => {
    const { user } = await renderApp(seedProject('First', 'DEMO'))
    await user.click(await screen.findByRole('button', { name: 'New project' }))
    await user.type(screen.getByLabelText('Name'), 'Second')
    const keyInput = screen.getByLabelText('Key')
    await user.clear(keyInput)
    await user.type(keyInput, 'DEMO')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect((await screen.findByRole('alert')).textContent).toContain('DEMO')
  })
})

describe('delete project', () => {
  test('requires typing the key to confirm, then removes the project', async () => {
    const { user } = await renderApp(seedProject('Doomed', 'DOOM'))

    await user.click(await screen.findByRole('button', { name: 'Delete Doomed' }))

    const deleteButton = screen.getByRole('button', { name: 'Delete project' })
    expect(deleteButton).toHaveProperty('disabled', true)

    const confirmInput = screen.getByLabelText('Project key')
    await user.type(confirmInput, 'WRONG')
    expect(deleteButton).toHaveProperty('disabled', true)

    await user.clear(confirmInput)
    await user.type(confirmInput, 'DOOM')
    expect(deleteButton).toHaveProperty('disabled', false)

    await user.click(deleteButton)

    expect(await screen.findByRole('button', { name: 'Create your first project' })).toBeDefined()
  })
})

describe('navigation', () => {
  test('a project links to its detail page', async () => {
    const { user } = await renderApp(seedProject('Demo', 'DEMO'))

    await user.click(await screen.findByRole('link', { name: /DEMO/ }))

    expect(await screen.findByText('Board coming soon.')).toBeDefined()
    expect(screen.getByRole('heading', { name: 'demo' })).toBeDefined()
  })
})
