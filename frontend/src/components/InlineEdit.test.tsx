import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InlineEdit } from './InlineEdit'

test('renders value as text', () => {
  render(<InlineEdit value="hello" onSave={vi.fn()} />)
  expect(screen.getByText('hello')).toBeInTheDocument()
})

test('clicking switches to input with current value', async () => {
  const user = userEvent.setup()
  render(<InlineEdit value="hello" onSave={vi.fn()} />)
  await user.click(screen.getByText('hello'))
  expect(screen.getByRole('textbox')).toHaveValue('hello')
})

test('Enter commits the new value', async () => {
  const user = userEvent.setup()
  const onSave = vi.fn()
  render(<InlineEdit value="hello" onSave={onSave} />)
  await user.click(screen.getByText('hello'))
  await user.clear(screen.getByRole('textbox'))
  await user.type(screen.getByRole('textbox'), 'world')
  await user.keyboard('{Enter}')
  expect(onSave).toHaveBeenCalledWith('world')
})

test('Escape cancels without saving', async () => {
  const user = userEvent.setup()
  const onSave = vi.fn()
  render(<InlineEdit value="hello" onSave={onSave} />)
  await user.click(screen.getByText('hello'))
  await user.keyboard('{Escape}')
  expect(onSave).not.toHaveBeenCalled()
  expect(screen.getByText('hello')).toBeInTheDocument()
})

test('does not save a blank value', async () => {
  const user = userEvent.setup()
  const onSave = vi.fn()
  render(<InlineEdit value="hello" onSave={onSave} />)
  await user.click(screen.getByText('hello'))
  await user.clear(screen.getByRole('textbox'))
  await user.keyboard('{Enter}')
  expect(onSave).not.toHaveBeenCalled()
})
