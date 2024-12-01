/**
 *
 * @param num
 */
function pad2(num) {
    const s = `0${num}`;
    return s.substring(s.length - 2);
}

module.exports = {
    pad2: pad2,
};
