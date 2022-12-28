const replacements = {
    '\r': Buffer.from('\'\\r\''),
    '\n': Buffer.from('\'\\n\''),
    '\026': Buffer.from('\'\\026\''),
};

const comma = Buffer.from(',');
const strConcatStart = Buffer.from('scc(');
const strConcatEnd = Buffer.from(')');

/**
 * Wrap a buffer with lua brackets.
 *
 * @param {Buffer} buf
 * @return {Buffer}
 */
function luaBracket(buf) {
    let e = -1;
    while (++e < 10) {
        let eq = '='.repeat(e);
        let pre = '[' + eq + '[';
        let suf = ']' + eq + ']';
        if (buf.includes(pre) || buf.includes(suf)) {
            continue;
        }

        if (buf.includes(suf.substring(0, suf.length - 1), -1 * (e + 1))) {
            continue;
        }

        return Buffer.concat([Buffer.from(pre), buf, Buffer.from(suf)]);
    }

    return Buffer.from("''");
}

/**
 * Quote a buffer to be included as a lua string.
 *
 * @param {Buffer} buf
 * @return {Buffer}
 */
function luaQuote(buf) {
    let parts = [];
    let bufStart = 0;

    do {
        let replacePos = -1;
        let replacement = '';
        for (let c in replacements) {
            if (!replacements.hasOwnProperty(c)) {
                continue;
            }

            let pos = buf.indexOf(c, bufStart);
            if (pos >= 0) {
                if (replacePos < 0 || replacePos > pos) {
                    replacePos = pos;
                    replacement = replacements[c];
                }
            }
        }

        if (replacePos < 0) {
            break;
        }

        if (replacePos > bufStart) {
            parts.push(luaBracket(buf.slice(bufStart, replacePos)));
        }
        parts.push(replacement);
        bufStart = replacePos + 1;
    } while (bufStart < buf.length);

    if (bufStart < buf.length) {
        parts.push(luaBracket(buf.slice(bufStart)));
    }
    for (let x = 1; x < parts.length; x += 2) {
        parts.splice(x, 0, comma);
    }
    parts.unshift(strConcatStart);
    parts.push(strConcatEnd);

    return Buffer.concat(parts);
}

module.exports = luaQuote;
