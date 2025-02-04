import { AnimEvents } from './anim-events.js';

/** @typedef {import('./anim-curve.js').AnimCurve} AnimCurve */
/** @typedef {import('./anim-data.js').AnimData} AnimData */

/**
 * AnimTrack contains a set of curve data which can be used to animate a set of target nodes.
 *
 * @ignore
 */
class AnimTrack {
    /**
     * Create a new AnimTrack instance.
     *
     * @param {string} name - The track name.
     * @param {number} duration - The duration of the track in seconds.
     * @param {AnimData[]} inputs - List of curve key data.
     * @param {AnimData[]} outputs - List of curve value data.
     * @param {AnimCurve[]} curves - The list of curves.
     * @param {AnimEvents} animEvents - A sequence of animation events.
     */
    constructor(name, duration, inputs, outputs, curves, animEvents = new AnimEvents([])) {
        this._name = name;
        this._duration = duration;
        this._inputs = inputs;
        this._outputs = outputs;
        this._curves = curves;
        this._animEvents = animEvents;
    }

    get name() {
        return this._name;
    }

    get duration() {
        return this._duration;
    }

    get inputs() {
        return this._inputs;
    }

    get outputs() {
        return this._outputs;
    }

    get curves() {
        return this._curves;
    }

    set events(animEvents) {
        this._animEvents = animEvents;
    }

    get events() {
        return this._animEvents.events;
    }

    // evaluate all track curves at the specified time and store results
    // in the provided snapshot.
    eval(time, snapshot) {
        snapshot._time = time;

        const inputs = this._inputs;
        const outputs = this._outputs;
        const curves = this._curves;
        const cache = snapshot._cache;
        const results = snapshot._results;

        // evaluate inputs
        for (let i = 0; i < inputs.length; ++i) {
            cache[i].update(time, inputs[i]._data);
        }

        // evaluate outputs
        for (let i = 0; i < curves.length; ++i) {
            const curve = curves[i];
            const output = outputs[curve._output];
            const result = results[i];
            cache[curve._input].eval(result, curve._interpolation, output);
        }
    }
}

export { AnimTrack };
