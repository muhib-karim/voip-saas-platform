import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Button } from '../src/components/ui/Button';

afterEach(() => cleanup());

describe('Button', () => {
    it('renders its label with the default variant and size classes', () => {
        render(<Button>Call</Button>);
        const btn = screen.getByRole('button', { name: 'Call' });
        expect(btn.className).toContain('btn-primary');
        expect(btn.className).toContain('btn-md');
        expect(btn.hasAttribute('disabled')).toBe(false);
    });

    it('applies variant, size and full-width classes', () => {
        render(
            <Button variant="danger" size="lg" fullWidth>
                Hang up
            </Button>,
        );
        const btn = screen.getByRole('button', { name: 'Hang up' });
        expect(btn.className).toContain('btn-danger');
        expect(btn.className).toContain('btn-lg');
        expect(btn.className).toContain('btn-full');
    });

    it('is disabled and ignores clicks while loading', () => {
        const onClick = vi.fn();
        render(
            <Button isLoading onClick={onClick}>
                Dialling
            </Button>,
        );
        const btn = screen.getByRole('button', { name: 'Dialling' });
        expect(btn.hasAttribute('disabled')).toBe(true);
        fireEvent.click(btn);
        expect(onClick).not.toHaveBeenCalled();
    });

    it('fires onClick when enabled', () => {
        const onClick = vi.fn();
        render(<Button onClick={onClick}>Answer</Button>);
        fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
        expect(onClick).toHaveBeenCalledTimes(1);
    });
});
