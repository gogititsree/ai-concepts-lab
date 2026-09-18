---
slug: stacking-neurons
title: Stacking neurons: layers and hidden features
orderIndex: 1
estimatedMinutes: 12
---

# Stacking neurons: layers and hidden features

One neuron draws one line, so XOR is out of reach. Two neurons in a hidden layer draw two
lines, and a third neuron on top can combine which side of each line a point falls on.
That is enough: a 2-2-1 network solves XOR, and you can set the nine weights by hand to
prove it before any training happens.

The hidden units are worth staring at. Each one is just another weighted sum, but what it
learns to respond to is a _feature_ -- "is the point above this line?" -- and the output
layer works on those features rather than on the raw inputs. Depth is how a network builds
features out of features.

The nonlinearity is not decoration. If every layer were purely linear, the composition of
all of them would still be a single linear map, and the whole stack would collapse back to
one line no matter how many layers you added. Sigmoid or tanh between layers is what makes
the extra layers buy you anything.
