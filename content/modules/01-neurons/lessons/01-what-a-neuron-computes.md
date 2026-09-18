---
slug: what-a-neuron-computes
title: What a neuron computes
orderIndex: 1
estimatedMinutes: 10
---

# What a neuron computes

A neuron takes a handful of numbers, multiplies each one by a weight, adds a bias, and
passes the result through an activation function. That is the whole of it: `z = w x + b`,
then `y = f(z)`. The weights say how much each input matters and in which direction; the
bias shifts the whole thing up or down independently of any input.

The interesting part is geometric. In two dimensions, `w x + b = 0` is a line, and the
sign of `z` tells you which side of that line a point falls on. Training a single neuron
is therefore not mysterious at all -- it is moving and rotating a line until the points of
one class are on one side and the points of the other class are on the other.

The activation function decides what "output" means. A step function gives a hard
yes/no and makes the neuron a classifier; a sigmoid gives a smooth probability-like
number between 0 and 1 and, crucially for the next module, has a derivative everywhere.
The exercise below lets you drag the line around by hand before you let the learning rule
do it for you.
