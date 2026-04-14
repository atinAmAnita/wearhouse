// HTTP error + async handler utilities.
// Throw HttpError anywhere in a route handler wrapped with ah() to produce
// a proper status code + JSON body via the global error middleware.

class HttpError extends Error {
    constructor(status, message, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

// Wrap async Express handlers so thrown errors forward to next(err).
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Final middleware — mount LAST, after all routes
function errorMiddleware(err, req, res, next) {
    const status = err.status || 500;
    const body = { error: err.message || 'Internal error' };
    if (err.details) body.details = err.details;
    if (status >= 500) console.error(`[${req.method} ${req.path}]`, err);
    res.status(status).json(body);
}

module.exports = { HttpError, ah, errorMiddleware };
