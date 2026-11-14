import React from 'react';
import { Provider } from 'jotai';
import { Bot } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { resolveNavigation } from 'librechat-data-provider';
import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
import { FeaturePresentationProvider, useFeaturePresentation } from '../Context';
import PresentationActions from '../Actions';

function ResourceEditor() {
  const { register } = useForm({ defaultValues: { name: '' } });
  const presentation = useFeaturePresentation()!;
  return (
    <>
      <input aria-label="Skill name" {...register('name')} />
      <PresentationActions page="skills" />
      <button onClick={() => presentation.expand('skills')}>{'Request expanded view'}</button>
      <button onClick={() => presentation.open('skills')}>{'Select Skills'}</button>
    </>
  );
}
const features = { skills: () => null };

it.each(['panel', 'page'] as const)(
  'keeps the selected editor and dirty values with a %s default',
  (defaultView) => {
    const router = createMemoryRouter(
      [
        {
          element: (
            <FeaturePresentationProvider
              features={features}
              links={[{ id: 'skills', title: 'com_ui_skills', icon: Bot }]}
              navigation={resolveNavigation({ pages: { skills: { defaultView } } })}
              onPanelOpen={jest.fn()}
            >
              <Outlet />
            </FeaturePresentationProvider>
          ),
          children: [
            { path: '/skills/:skillId/edit', element: <ResourceEditor /> },
            { path: '/skills', element: <div>{'Collection'}</div> },
          ],
        },
      ],
      { initialEntries: ['/skills/skill-a/edit'] },
    );
    render(
      <Provider>
        <RouterProvider router={router} />
      </Provider>,
    );
    const name = screen.getByLabelText('Skill name');
    fireEvent.change(name, { target: { value: 'Unsaved skill name' } });
    expect(screen.queryByRole('button', { name: 'Expand' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Request expanded view'));
    fireEvent.click(screen.getByText('Select Skills'));
    expect(router.state.location.pathname).toBe('/skills/skill-a/edit');
    expect(screen.getByLabelText('Skill name')).toBe(name);
    expect(name).toHaveValue('Unsaved skill name');
  },
);
