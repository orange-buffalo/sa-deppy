const parseRawDependenciesList = require('../src/raw-dependencies-parser');

describe('Parser of raw dependencies string', () => {
  test('parses single dependency', () => {
    expect(parseRawDependenciesList('dep:version')).toEqual([{
      name: 'dep',
      version: 'version',
    }]);
  });

  test('trims whitespaces', () => {
    expect(parseRawDependenciesList('  dep:version  ')).toEqual([{
      name: 'dep',
      version: 'version',
    }]);
  });

  test('parses dependencies separated by space', () => {
    expect(parseRawDependenciesList('dep1:version1  dep2:version2 group3:dep3:version3')).toEqual([{
      name: 'dep1',
      version: 'version1',
    }, {
      name: 'dep2',
      version: 'version2',
    }, {
      name: 'group3:dep3',
      version: 'version3',
    }]);
  });

  test('parses dependencies separated by comma', () => {
    expect(parseRawDependenciesList('dep1:version1,  dep2:version2 , group3:dep3:version3')).toEqual([{
      name: 'dep1',
      version: 'version1',
    }, {
      name: 'dep2',
      version: 'version2',
    }, {
      name: 'group3:dep3',
      version: 'version3',
    }]);
  });

  test('parses dependencies separated by comma and spaces', () => {
    expect(parseRawDependenciesList('dep1:version1  dep2:version2, group3:dep3:version3')).toEqual([{
      name: 'dep1',
      version: 'version1',
    }, {
      name: 'dep2',
      version: 'version2',
    }, {
      name: 'group3:dep3',
      version: 'version3',
    }]);
  });
})
