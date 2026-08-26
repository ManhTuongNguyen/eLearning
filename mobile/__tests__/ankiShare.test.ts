/**
 * Anki share seam tests (SPEC TASK-075): the exported CSV is written to the
 * app cache directory under the backend's export filename and the system
 * share/save sheet receives a typed file URI for that file. Filesystem
 * failures propagate to the caller (without opening the sheet) so the screen
 * can show its error state; cancelling the sheet is not an error.
 */
import ReactNativeBlobUtil from 'react-native-blob-util';
import Share from 'react-native-share';

import {VOCABULARY_EXPORT_FILENAME} from '../src/api/vocabulary';
import {shareAnkiCsv} from '../src/utils/ankiShare';

const mockedWriteFile = jest.mocked(ReactNativeBlobUtil.fs.writeFile);
const mockedOpen = jest.mocked(Share.open);

describe('shareAnkiCsv', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('writes the CSV to cache storage and opens the share sheet with a typed file URI', async () => {
    const csv = 'Front,Back,Example,Pronunciation\n"set off","phrasal verb",, \n';

    await shareAnkiCsv(csv);

    expect(mockedWriteFile).toHaveBeenCalledWith(
      `/mock-cache/${VOCABULARY_EXPORT_FILENAME}`,
      csv,
      'utf8',
    );
    expect(mockedOpen).toHaveBeenCalledWith({
      url: `file:///mock-cache/${VOCABULARY_EXPORT_FILENAME}`,
      type: 'text/csv',
      filename: VOCABULARY_EXPORT_FILENAME,
      failOnCancel: false,
    });
  });

  it('propagates filesystem failures without opening the share sheet', async () => {
    mockedWriteFile.mockRejectedValueOnce(new Error('disk full'));

    await expect(shareAnkiCsv('Front,Back\n')).rejects.toThrow('disk full');
    expect(mockedOpen).not.toHaveBeenCalled();
  });
});
