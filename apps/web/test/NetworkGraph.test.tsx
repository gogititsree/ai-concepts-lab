import { backward, createMlp, forward } from '@lab/nn-core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { NetworkGraph } from '../src/features/exercises/mlp/NetworkGraph';

const net = createMlp({ layerSizes: [2, 3, 1], hiddenActivation: 'tanh', seed: 42 });

describe('NetworkGraph', () => {
  it('draws one node per unit and one edge per weight for a 2-3-1 network', () => {
    render(
      <NetworkGraph
        mlp={net}
        activations={null}
        gradients={null}
        animationLayer={-1}
        phase="idle"
      />,
    );

    // 2 inputs + 3 hidden + 1 output.
    expect(screen.getAllByTestId('network-node')).toHaveLength(6);
    // 2*3 into the hidden layer, 3*1 into the output.
    expect(screen.getAllByTestId('network-edge')).toHaveLength(9);
  });

  it('scales with the hidden size', () => {
    const wide = createMlp({ layerSizes: [2, 8, 1], seed: 1 });
    render(
      <NetworkGraph
        mlp={wide}
        activations={null}
        gradients={null}
        animationLayer={-1}
        phase="idle"
      />,
    );
    expect(screen.getAllByTestId('network-node')).toHaveLength(11);
    expect(screen.getAllByTestId('network-edge')).toHaveLength(24);
  });

  it('labels nodes with their activation once a forward pass exists', () => {
    const pass = forward(net, [0.5, -0.25]);
    render(
      <NetworkGraph
        mlp={net}
        activations={pass.activations}
        gradients={null}
        animationLayer={3}
        phase="forward"
      />,
    );
    const output = pass.output[0]!.toFixed(2);
    expect(screen.getAllByText(output).length).toBeGreaterThan(0);
  });

  it('reports the gradient alongside the weight during the backward phase', () => {
    const pass = forward(net, [0.5, -0.25]);
    const grads = backward(net, pass, [1], 'mse');
    const { container } = render(
      <NetworkGraph
        mlp={net}
        activations={pass.activations}
        gradients={grads}
        animationLayer={0}
        phase="backward"
      />,
    );
    const titles = [...container.querySelectorAll('line > title')].map((node) => node.textContent);
    expect(titles).toHaveLength(9);
    expect(titles.every((title) => title?.includes('dL/dw'))).toBe(true);
  });

  it('explains its own encoding when nothing is hovered', () => {
    render(
      <NetworkGraph
        mlp={net}
        activations={null}
        gradients={null}
        animationLayer={-1}
        phase="idle"
      />,
    );
    expect(screen.getByTestId('network-hover')).toHaveTextContent(/width is magnitude/i);
  });
});
