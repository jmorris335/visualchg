from constrainthg import Hypergraph

# TODO: Load the JSON script from the underlying editor as json_data


def get_inputs(json_data: dict, frame_key: str) -> dict:
    """Returns a dictionary of inputs for a simulation."""
    try:
        inputs = dict(json_data['frames'][frame_key])
    except:
        inputs = {}
    finally:
        return inputs
    
def make_hypergraph(json_data: dict) -> Hypergraph:
    """Creates the hypergraph from the JSON file."""
    hg = Hypergraph()
    try:
        hg.from_json(json_data)
    finally:
        return hg
    
def simualte(json_data: dict, output_node: str, frame_key: str, **kwargs): 
    """Simulates a hypergraph for the specified output_node."""
    hg = make_hypergraph(json_data)
    inputs = get_inputs(json_data, frame_key)
    t = hg.solve(output_node, inputs=inputs, **kwargs)
    return t