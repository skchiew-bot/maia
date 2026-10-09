import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ToastProvider } from '../src/components';
import GalleryPage from '../src/pages/dev/GalleryPage';

describe('design system gallery', () => {
  // The gallery shows both nav variants side by side; two landmarks named alike fail axe `landmark-unique`.
  it('names every navigation landmark differently, including the two side nav examples', () => {
    render(
      <MemoryRouter initialEntries={['/dev/gallery']}>
        <ToastProvider>
          <GalleryPage />
        </ToastProvider>
      </MemoryRouter>,
    );
    const names = screen.getAllByRole('navigation').map((n) => n.getAttribute('aria-label') ?? '');
    expect(names).toEqual(
      expect.arrayContaining(['Gallery sections', 'Primary, expanded example', 'Primary, icon rail example']),
    );
    expect(names.filter((n) => n === 'Primary')).toEqual([]);
    expect(new Set(names).size).toBe(names.length);
  });
});
